-- Pass 4 of RLS-ROADMAP.md: user_clinics, the trust-anchor table every
-- other clinic-scoped policy already depends on via EXISTS subqueries
-- (rls_practitioner_manages_patient(), defined in
-- 0003_assigned_programs_rls.sql) or the app-layer equivalent
-- (UsersService.getClinicIdsForUser()/isPatientManagedBy()). Reuses
-- rls_is_admin() and rls_current_user_id(), both from
-- 0003_assigned_programs_rls.sql — no new helper needed.
--
-- Scope, confirmed by a fresh grep across all of src/ and scripts/, not
-- trusted from the roadmap's own prompt:
--
-- INSERT: ClinicsService.addMember() (admin-only route, already wrapped in
--   withRlsContext), AuthService.registerClinic()'s bootstrap (the fifth
--   insert of a five-insert transaction: clinics -> users ->
--   user_roles(role='admin') -> admin_profiles -> user_clinics, no session
--   to derive context from), and — NOT in the roadmap's own framing, a
--   real finding of this pass — UsersService.create()'s dto.clinicId
--   branch, reachable under a REAL PRACTITIONER SESSION: POST /users is
--   @Roles(PRACTITIONER, ADMIN), and create() already contains its own
--   app-layer ownership check (added specifically for this, see the
--   comment above it) confirming the requesting practitioner's own
--   getClinicIdsForUser() includes dto.clinicId before the insert is ever
--   reached. Unlike practitioner_profiles in Pass 3 (no real call site
--   needed a practitioner branch), this table DOES need one.
-- DELETE: ClinicsService.removeMember() (admin-only route, already wrapped
--   in withRlsContext). No practitioner-session or no-context branch
--   needed — re-confirmed directly, not assumed from INSERT's shape:
--   removeMember() is the only DELETE call site anywhere against this
--   table, and its route is @Roles(UserRole.ADMIN) only.
-- UPDATE: none anywhere — confirmed directly by grep, not assumed from any
--   other table's precedent. Membership is genuinely insert/delete-only
--   (join a clinic / leave a clinic); no code path ever updates an
--   existing user_clinics row in place.
-- SELECT: the load-bearing one. UsersService.getClinicIdsForUser(userId)
--   is a shared PRIVATE helper backing THREE call sites —
--   findPatientsForPractitioner(), create()'s own clinic-ownership check
--   above, and isPatientManagedBy() (the app's central "is this my
--   patient" check, called from UsersController and from
--   MedicalFilesService/AssignedProgramsService/SessionsService/
--   MessagingService, i.e. almost everywhere) — and it ALWAYS queries via
--   `this.db`, never a `tx`, so it never carries whatever RLS context an
--   outer withRlsContext call might have set. Most of its callers run
--   BEFORE any such transaction even opens.

-- ============================================================================
-- SELECT: USING (true), proven the same load-bearing way as users_select
-- (0007), user_roles_select (0009), and all three profile tables' _select
-- (0010) — not a lighter "no sensitivity" call like clinics_select (0008).
--
-- A self-or-managing-practitioner-shaped restrictive candidate was drafted
-- and adversarially tested on a scratch copy in stride_test before being
-- rejected, not assumed to fail. A real practitioner, a real clinic, and a
-- real membership row were seeded (owner connection). With the candidate
-- policy
--   USING (
--     current_setting('app.current_role', true) = 'admin'
--     OR user_id = current_setting('app.current_user_id', true)::integer
--   )
-- live and FORCE'd, the EXACT query getClinicIdsForUser() issues — a bare
-- `SELECT clinic_id FROM user_clinics WHERE user_id = $1` through
-- stride_app, zero session context set, the precise shape of every
-- pre-context call (isPatientManagedBy() chief among them) — returned:
--
--   clinic_id
--   ----------
--   (0 rows)
--
-- Zero rows, for a real practitioner's own real membership. Concretely,
-- this breaks THREE things at once: isPatientManagedBy() sees
-- clinicIds.length === 0 and returns false immediately — a real managed
-- patient reads as unmanaged, everywhere that check gates (users,
-- medical_files, assigned_programs, sessions, messaging);
-- findPatientsForPractitioner() returns [] for every practitioner, for the
-- same reason; and create()'s own ownClinicIds.includes(dto.clinicId)
-- check would reject a practitioner adding a patient to a clinic they
-- genuinely belong to. Not a narrow edge case — every practitioner-gated
-- authorization check in the app routes through this exact contextless
-- read.
--
-- A managing-practitioner-shaped variant (adding
-- `OR (current_setting('app.current_role', true) = 'practitioner' AND
-- EXISTS (SELECT 1 FROM user_clinics uc2 WHERE uc2.user_id =
-- current_setting('app.current_user_id', true)::integer AND
-- uc2.clinic_id = user_clinics.clinic_id))`) was tried too and failed a
-- different way: Postgres reported "infinite recursion detected in policy
-- for relation user_clinics" — a self-referencing EXISTS subquery against
-- the very table whose policy it's part of. This is a second, independent
-- reason a restrictive policy is structurally wrong here, on top of the
-- contextless-read problem: rls_practitioner_manages_patient() itself
-- joins user_clinics against itself, so reusing it (or its shape) INSIDE
-- user_clinics' own policy is circular in a way it never is when called
-- from a DIFFERENT table's policy (assigned_programs, users, the profile
-- tables, ...).
--
-- This also settles Pass 4's own SECURITY DEFINER question (RLS-ROADMAP.md
-- step 3) without needing to prototype it: SECURITY DEFINER changes WHICH
-- PRIVILEGES a function's query runs with, not what current_setting()
-- returns. getClinicIdsForUser()'s callers don't fail because stride_app
-- lacks privilege to see the row — they fail because no RLS context is
-- set AT ALL in this call path, by design (it runs before a session's
-- role is even known, the same structural reason users_select and
-- user_roles_select each already reached USING (true)). A
-- SECURITY DEFINER wrapper around a self-or-managing-practitioner
-- condition would evaluate the identical current_setting(...) calls and
-- get the identical NULLs — it doesn't address the actual failure
-- mechanism, so it was not prototyped against the real schema. Confirmed
-- fix: swapping in USING (true) and re-running the identical query
-- returned the real row (`clinic_id = 11`) with the same zero context set.
-- stride_test was left in its original state after every experiment above
-- — each ran inside BEGIN/ROLLBACK, re-confirmed empty of scratch rows and
-- RLS disabled afterward.
--
-- This doesn't expose anything downstream doesn't already gate: the one
-- admin-only route that lists raw membership (ClinicsService.
-- listMembers(), GET /clinics/:id/members) is unaffected by this policy
-- either way since it already requires @Roles(UserRole.ADMIN); every other
-- read of this table happens only through getClinicIdsForUser()/
-- isPatientManagedBy(), which are pure internal building blocks, never
-- returned directly to a client. RLS provides no additional read-side
-- defense-in-depth on this table, the same conclusion users_select,
-- user_roles_select, and all three profile tables' _select already
-- reached for their own tables.
-- ============================================================================

ALTER TABLE user_clinics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_clinics FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY user_clinics_select ON user_clinics
  FOR SELECT USING (true);--> statement-breakpoint

-- Insert: three branches.
--
-- 1. Admin session: any user, any clinic — matches addMember()'s own
--    @Roles(UserRole.ADMIN) gate and the admin branch of create().
-- 2. Practitioner session: only into a clinic the practitioner THEMSELVES
--    already belongs to. This is a real, additional check beyond what
--    users_insert/patient_profiles_insert's own "any practitioner session,
--    no finer check" precedent uses elsewhere in this rollout — deliberate
--    here, not an oversight: this table is the one every other table's
--    clinic-scoped policy depends on, so the WITH CHECK mirrors create()'s
--    own real app-layer invariant (ownClinicIds.includes(dto.clinicId))
--    directly against the table itself, rather than leaving the finer
--    rule enforced solely at the app layer the way the coarser tables in
--    this rollout do. The EXISTS subquery reads only PRE-EXISTING rows (a
--    practitioner is onboarded into any clinic exclusively via addMember(),
--    an admin-only insert, before they can ever reach this branch), so
--    this isn't self-referential the way the bootstrap branch below has to
--    guard against — it can't be satisfied by the very row being inserted.
-- 3. No context at all: registerClinic()'s bootstrap, the fifth insert of
--    its five-insert transaction. Deliberately NOT the plain
--    NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') that
--    clinics_insert (0008) and user_roles_insert (0009) use unmodified —
--    copying that verbatim here would repeat admin_profiles_insert's own
--    first-draft bug (0010): by the time this insert runs,
--    user_roles(role='admin') for this exact new user was already
--    inserted two statements earlier in the SAME transaction, and a
--    transaction always sees its own prior writes. A plain NOT EXISTS
--    would already be false by the time user_clinics is reached — the
--    bootstrap's own earlier statement tripping its own later check, the
--    identical trap admin_profiles_insert's first version fell into.
--    Fixed the same way: "no OTHER admin exists yet", excluding the row's
--    own user_id from the check.
CREATE POLICY user_clinics_insert ON user_clinics
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR (
      current_setting('app.current_role', true) = 'practitioner'
      AND EXISTS (
        SELECT 1 FROM user_clinics existing
        WHERE existing.user_id = rls_current_user_id()
          AND existing.clinic_id = user_clinics.clinic_id
      )
    )
    OR (
      NULLIF(current_setting('app.current_role', true), '') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.role = 'admin' AND ur.user_id <> user_clinics.user_id
      )
    )
  );--> statement-breakpoint

-- Delete: admin session only, matching removeMember()'s own
-- @Roles(UserRole.ADMIN) gate — the only DELETE call site against this
-- table anywhere in src/ or scripts/.
CREATE POLICY user_clinics_delete ON user_clinics
  FOR DELETE
  USING (rls_is_admin());--> statement-breakpoint

-- No UPDATE policy — confirmed by a fresh grep across src/ and scripts/
-- that no code path ever issues one against user_clinics: membership is
-- genuinely insert/delete-only (join a clinic / leave a clinic), no
-- in-between state to update. Under FORCE ROW LEVEL SECURITY with no
-- policy for a given command, that command is rejected outright for every
-- role, including admin — correct here, since nothing in the app ever
-- needs a real UPDATE against this table to work.
