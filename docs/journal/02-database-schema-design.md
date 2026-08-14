# Database schema: design decisions & rationale

This document explains the reasoning behind the PostgreSQL schema's structure —
not just what tables exist, but the patterns and judgment calls that shaped them.
Column-by-column DDL lives in the Drizzle schema files; this is the "why" behind it.

## Entity overview

| Table | Purpose |
|---|---|
| `clinics` | Tenant/branding info (name, contact, logo) — no access-control power of its own |
| `user_clinics` | Many-to-many link between users and clinics |
| `users` | Central identity table for everyone who logs in (auth fields + role) |
| `practitioner_profiles` / `patient_profiles` / `admin_profiles` | Role-specific fields, one row per user, split from `users` |
| `medical_files` | Patient clinical chart entries (append-only history, not a single mutable record) |
| `conversations` / `messages` | Practitioner–patient direct messaging |
| `exercises` | Exercise library — combines a seeded open dataset with practitioner-authored custom entries |
| `program_templates` / `template_exercises` | Practitioner-authored presets, reusable across patients |
| `assigned_programs` / `assigned_program_exercises` | A concrete plan given to a specific patient — an independent copy, not a live reference to a template |
| `sessions` / `session_exercises` | Each scheduled occurrence of "patient does their exercises," with per-exercise outcomes (completion, timing, difficulty, feedback) |
| `audit_logs` | Immutable, insert-only ledger of who did what to which record and when |

## Key design patterns

### 1. Users: one identity table, split profiles

Rather than four unrelated user tables (admin/practitioner/patient/clinic), `users`
holds shared identity and auth fields (`email`, `password_hash`, `role`), and each
role's specific fields live in its own 1:1 profile table
(`practitioner_profiles`, `patient_profiles`, `admin_profiles`), keyed directly by
`user_id` as primary key rather than a separate surrogate ID. Everything else in
the schema (messages, audit logs, sessions) references `users.id` — a single,
consistent identity to join against, regardless of role.

### 2. Copy, not reference, for assigned programs

`program_templates` and `assigned_programs` are deliberately separate concepts,
with `assigned_program_exercises` holding an independent **copy** of the relevant
`template_exercises` row at the moment of assignment, rather than a live foreign
key back to the template. If a practitioner edits or removes a preset later,
patients already assigned that preset are unaffected — what a patient was
actually told to do on a given date is preserved, which matters for a clinical
record. This is also why `assigned_programs.based_on_template_id` uses
`ON DELETE SET NULL`: the link back to the source template is provenance only,
never something the assigned program's content depends on.

### 3. Audit log: one table, insert-only

All application activity — logins, record access, plan modifications — writes to
a single `audit_logs` table rather than being split per entity or per user role.
One table makes cross-cutting questions ("everything that happened to patient X,"
"everything practitioner Y did last week") a single indexed query instead of a
union across an unknown number of tables. The table is treated as insert-only at
the application permission level: no `UPDATE` or `DELETE` is ever issued against
it, so the history it records cannot be silently altered.

### 4. Soft delete, never hard delete, for anything with history

`users.is_active`, `exercises.is_archived`, `program_templates.is_archived`, and
`assigned_programs.is_archived` all follow the same rule: removal from the UI
does not mean removal from the database. This is enforced structurally, not just
by convention — nearly every foreign key pointing at `users` uses
`ON DELETE RESTRICT`, so the database itself refuses a hard delete that would
orphan clinical history, forcing a soft-delete flag to be used instead.

### 5. `ON DELETE` chosen per relationship, not defaulted

Every foreign key's delete behavior was chosen deliberately based on one
question: *if the parent row disappeared, would this child row still mean
anything on its own?*

- **`RESTRICT`** (most references to `users`, and any clinically meaningful
  record — `medical_files`, `assigned_programs`, `sessions`): the child is an
  independent record with real evidentiary value; the database refuses the
  delete and forces a deliberate soft-delete instead.
- **`CASCADE`** (e.g. `template_exercises` → `program_templates`,
  `session_exercises` → `sessions`): the child is pure composition with no
  meaning apart from its parent.
- **`SET NULL`** (`exercises.created_by`, `assigned_programs.based_on_template_id`):
  the child is independent and still useful on its own — only the provenance
  link is optional.

### 6. JSONB used selectively, not as a default

JSONB columns (`clinical_data`, `audit_logs.details`) are reserved for genuinely
variable-shaped data that won't be filtered, sorted, or constrained at the
database level. Anything that needs validation, uniqueness, or fast filtering —
`date_of_birth`, `license_number`, exercise `duration_in_seconds`,
`difficulty_rating` — is a typed column instead, including a `CHECK` constraint
on `difficulty_rating` to enforce a valid 1–10 range at the database layer
rather than trusting application code alone.

### 7. Explicit `NOT NULL` throughout, not left implicit

Every column has a deliberate nullability decision rather than relying on
Postgres's default-nullable behavior unreviewed. In particular:

- Booleans are always `NOT NULL` with an explicit `DEFAULT` — a nullable boolean
  creates an ambiguous three-state value that's rarely actually wanted.
- Arrays (`equipment`, `specialties`, `media_urls`) default to an empty array
  (`'{}'::text[]`) rather than `NULL`, so application code only ever handles one
  shape (a possibly-empty list) instead of two.
- Nullable timestamps are used deliberately as an implicit status signal —
  `messages.read_at`, `sessions.started_at`/`completed_at` — where `NULL` means
  "hasn't happened yet," which is more information-preserving than a boolean flag.

## Relationship to the HIPAA Security Rule technical safeguards

This schema's structure directly supports the technical safeguards described in
45 CFR §164.312, as outlined in the accompanying architecture writeup:

- **Audit controls** — the insert-only `audit_logs` table.
- **Integrity controls** — the copy-not-reference pattern for assigned programs,
  `RESTRICT`-by-default foreign keys preventing silent data loss, and `CHECK`
  constraints enforcing valid data at the database layer.
- **Access control** — the `users.role` field combined with (planned) PostgreSQL
  Row-Level Security policies, enforcing per-patient and per-practitioner data
  isolation at the database layer, not solely in application code.
