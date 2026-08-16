-- Pass 3 of RLS-ROADMAP.md: practitioner_profiles, patient_profiles,
-- admin_profiles. Reuses rls_is_admin(), rls_current_user_id(), and
-- rls_practitioner_manages_patient() from 0003_assigned_programs_rls.sql, and
-- the exact NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
-- bootstrap invariant already established in 0008_clinics_rls.sql's
-- clinics_insert and 0009_user_roles_rls.sql's user_roles_insert — no new
-- helper needed anywhere in this file.
--
-- Docs 30 and 31 are prerequisite reading, not incidental history: doc 30
-- built UsersService.attachProfile()/attachProfilesToMany(), the only real
-- read path against these three tables (before it, nothing read this data
-- back at all); doc 31 built the only real UPDATE path
-- (UsersService.update()). Both landed specifically so this pass could be
-- designed against corrected, real behavior instead of the "nothing reads
-- this" gap that predated them, per this project's own "investigate the
-- real current rule first" discipline.
--
-- Scope, confirmed by a fresh grep across all of src/ and scripts/ (which
-- touches none of these three tables), not trusted from the roadmap's own
-- prompt or docs 30/31's own accounting of themselves:
--
-- SELECT: UsersService.attachProfile() (create/findOne/update/softDelete/
--   updateAvatar) and attachProfilesToMany() (findAll/
--   findPatientsForPractitioner), both querying all three tables
--   conditionally on the target's held roles. attachProfile()'s dbOrTx
--   parameter defaults to this.db, so any call site that doesn't pass a real
--   tx explicitly runs with whatever RLS context (if any) that connection
--   happens to carry — and AuthService.validateUser(), the login path
--   itself, calls it with NO context at all, before any session exists.
--   AuthService.registerClinic() also calls it, but WITH its own open tx.
-- INSERT: UsersService.create() (practitioner_profiles, patient_profiles,
--   and admin_profiles, each gated on dto.role — see the per-table
--   breakdown below), UsersService.grantRole() (all three, admin-only route,
--   already run inside withRlsContext per doc 29's own scope-gap fix — no
--   change needed here, just confirmed), and AuthService.registerClinic()
--   (admin_profiles only, the one-time founding-admin bootstrap, run inside
--   a plain db.transaction() with no session to derive context from).
-- UPDATE: UsersService.update() only, all three tables, always inside
--   withRlsContext with a real currentUser — unlike users_insert/
--   user_roles_insert/clinics_insert, this route has no unauthenticated
--   bootstrap path at all (UpdateUserDto has no equivalent to
--   CreateUserDto's public-register() branch), so no "no context" UPDATE
--   branch is needed here the way INSERT needed one.
-- DELETE: none anywhere — re-confirmed directly by grep, not trusted from
--   any prior doc's note about a different table. No
--   .delete(practitionerProfiles/patientProfiles/adminProfiles) call exists
--   in src/.

-- ============================================================================
-- SELECT: USING (true) on all three tables, for the SAME load-bearing reason
-- as users_select (0007) and user_roles_select (0009), not a lighter
-- "no sensitivity" call like clinics_select. A narrower
-- self-or-admin-or-managing-practitioner candidate (the shape this table's
-- write rule below actually uses) was drafted and adversarially tested
-- before being rejected, not assumed to fail:
--
-- With that candidate policy live on patient_profiles in stride_test and a
-- real patient row seeded (a genuine patient_profiles row, date_of_birth
-- '1990-05-15'), the exact query attachProfile() issues during login — a
-- bare `SELECT * FROM patient_profiles WHERE user_id = $1` through
-- stride_app, with zero session context set, the precise shape of
-- AuthService.validateUser() calling attachProfile() with no tx — returned:
--
--   user_id | phone | address | date_of_birth
--   --------+-------+---------+---------------
--   (0 rows)
--
-- Zero rows, for a real patient's own profile. Under the narrow policy, this
-- means patientProfile silently vanishes from EVERY patient login response
-- — not a hard failure the way user_roles_select's rejected candidate
-- produced (a wrong 400/403), but a real regression: it would silently
-- resurrect the exact "written once, never read back" bug doc 30 just
-- finished fixing, via a different mechanism (RLS instead of a missing read
-- path). The same structural cause — attachProfile() querying via this.db,
-- never a tx, so it never carries whatever context an outer withRlsContext
-- call might have set — applies identically to practitioner_profiles and
-- admin_profiles; not re-tested table-by-table, since the mechanism (and
-- attachProfile()'s own code) is one function shared across all three, not
-- three independent implementations.
--
-- Swapping in USING (true) and re-running the identical query confirmed the
-- fix: the same real row came back correctly, with no session context set,
-- exactly matching a genuine no-context login. stride_test was left in its
-- original state once the experiment concluded — the candidate policy
-- dropped, RLS disabled again on patient_profiles, and the scratch user
-- deleted (cascading to its patient_profiles/user_roles rows) via the owner
-- connection, re-confirmed empty afterward.
--
-- This doesn't expose anything downstream doesn't already gate: every real
-- call site that reaches attachProfile()/attachProfilesToMany() does so
-- only after the app-layer check that decides whether the underlying user
-- row is returned at all (UsersController's isSelf/isAdmin/
-- isManagingPractitioner for single-user routes; findAll() is admin-only;
-- findPatientsForPractitioner()'s row set is already clinic-scoped by its
-- own join before attachProfilesToMany() ever runs) — RLS provides no
-- additional read-side defense-in-depth on these three tables, the same
-- conclusion users_select and user_roles_select each already reached for
-- their own tables.
-- ============================================================================

ALTER TABLE practitioner_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE practitioner_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY practitioner_profiles_select ON practitioner_profiles
  FOR SELECT USING (true);--> statement-breakpoint

-- Insert: admin session ONLY. Confirmed directly, not assumed from
-- symmetry with the other two tables — create() forbids a practitioner
-- session from inserting dto.role !== 'patient' at all, so a practitioner
-- session can never reach the practitioner_profiles insert branch;
-- register() (the one no-context caller of create()) hardcodes
-- role: UserRole.PATIENT unconditionally, so the no-context path can never
-- reach it either. grantRole() is @Roles(UserRole.ADMIN)-gated at the
-- controller. registerClinic() never touches this table at all — its
-- bootstrap only ever inserts into admin_profiles. No practitioner-session
-- or no-context branch exists here because no real call site needs one.
CREATE POLICY practitioner_profiles_insert ON practitioner_profiles
  FOR INSERT
  WITH CHECK (rls_is_admin());--> statement-breakpoint

-- Update: the exact shape of users_update (0007) — self, admin, or a
-- managing practitioner — reused directly, not redesigned. This mirrors
-- users_update's own reasoning: UsersController.update()'s existing
-- isSelf/isAdmin/isManagingPractitioner check is the real authorization
-- (UsersService.update() additionally checks the TARGET's held roles before
-- ever reaching this table, rejecting a mismatched field with a 400), so
-- this policy is a database-level backstop mirroring that same rule, not a
-- new one. rls_practitioner_manages_patient() doesn't inspect the target
-- row's own role (pure clinic-overlap, same as UsersService.
-- isPatientManagedBy(), which users_update already reuses this way against
-- ANY users.id regardless of role) — reused unchanged here against
-- practitioner_profiles.user_id for the identical reason.
CREATE POLICY practitioner_profiles_update ON practitioner_profiles
  FOR UPDATE
  USING (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  )
  WITH CHECK (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  );--> statement-breakpoint

-- No DELETE policy — no code path anywhere issues one against this table.
-- Under FORCE ROW LEVEL SECURITY with no policy for a given command, that
-- command is rejected outright for every role, including admin.

ALTER TABLE patient_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY patient_profiles_select ON patient_profiles
  FOR SELECT USING (true);--> statement-breakpoint

-- Insert: NOT symmetric with practitioner_profiles — three real branches,
-- confirmed directly against create()/register() rather than assumed from
-- the roadmap's own description. The exact shape of users_insert (0007):
-- admin session (create()'s admin branch, or grantRole(), admin-only);
-- practitioner session (create()'s "practitioners can only create patient
-- accounts" branch — a practitioner creating their own managed patient,
-- confirmed as the only role value a practitioner session's create() call
-- can ever reach); or no context at all, covering register()'s public
-- self-registration bootstrap, which hardcodes role: UserRole.PATIENT
-- unconditionally, the only no-context path that reaches this table.
-- Deliberately as coarse as users_insert, not gated by any further check —
-- patient_profiles has no role column of its own to gate on the way
-- user_roles_insert's WITH CHECK could, so the finer rule (a practitioner
-- may only ever create a patient, already checked once at the app layer;
-- a practitioner's own clinic-membership check on dto.clinicId, also
-- app-layer only) stays enforced solely by UsersService.create(), the same
-- "RLS draws the coarse boundary, the app enforces the finer rule"
-- principle users_insert's own comment already states.
CREATE POLICY patient_profiles_insert ON patient_profiles
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR current_setting('app.current_role', true) = 'practitioner'
    OR NULLIF(current_setting('app.current_role', true), '') IS NULL
  );--> statement-breakpoint

-- Update: identical shape to practitioner_profiles_update above — see that
-- policy's comment for the full reasoning, which applies unchanged here.
CREATE POLICY patient_profiles_update ON patient_profiles
  FOR UPDATE
  USING (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  )
  WITH CHECK (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  );--> statement-breakpoint

-- No DELETE policy — same reasoning as practitioner_profiles above.

ALTER TABLE admin_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE admin_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY admin_profiles_select ON admin_profiles
  FOR SELECT USING (true);--> statement-breakpoint

-- Insert: admin session, OR no context specifically when no admin exists
-- yet. create()'s admin branch (an existing admin creating a new admin
-- account, dto.role === 'admin') and grantRole() (admin-only route) both
-- satisfy rls_is_admin() directly. AuthService.registerClinic() is the one
-- no-context caller — a plain db.transaction() with no session, gated on
-- its own application-layer check (the SAME "does an admin already exist"
-- question, re-derived independently in TypeScript) before ever reaching
-- this INSERT. No practitioner-session branch exists — create() forbids a
-- practitioner session from ever inserting dto.role === 'admin', and there
-- is no other call site that would need one.
--
-- The bootstrap condition is deliberately NOT the plain
-- NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') that
-- clinics_insert (0008) and user_roles_insert (0009) both use unmodified —
-- copying it here verbatim was tried first and adversarially proven wrong
-- by the real e2e suite, not caught by inspection. registerClinic() runs
-- clinics -> users -> user_roles(role='admin') -> admin_profiles, all four
-- inserts inside ONE transaction; by the time execution reaches this
-- table, the user_roles(role='admin') row for this exact new user has
-- already been inserted by the PRECEDING statement in the same
-- transaction, and is visible to this policy's own subquery (a
-- transaction always sees its own prior writes, committed or not). A
-- plain NOT EXISTS (admin) is therefore already false by the time
-- admin_profiles is reached — the bootstrap's own earlier statement trips
-- its own later check. This is NOT the same situation clinics_insert or
-- user_roles_insert are in: clinics is inserted BEFORE user_roles in this
-- same transaction, and user_roles_insert's own NOT EXISTS runs at the
-- exact moment that row is being created, before it exists to see. Caught
-- for real: every e2e suite's founding-admin bootstrap fixture failed
-- identically with "Failed query: insert into admin_profiles ... " /
-- 500 Internal Server Error the first time this migration was actually
-- run against the full test suite, not a theoretical concern.
--
-- Fixed by excluding the row's own user_id from the NOT EXISTS check —
-- "no OTHER admin exists yet," not "no admin row exists at all." This is
-- exactly what the bootstrap needs: by the time admin_profiles is reached,
-- the ONLY user_roles(role='admin') row that can possibly exist is the one
-- for this same new user (an admin-less database is the precondition
-- registerClinic()'s own app-layer check already enforced before the
-- transaction opened at all), so requiring no DIFFERENT admin to exist is
-- equivalent to the intended invariant without being defeated by the
-- transaction's own prior statement.
CREATE POLICY admin_profiles_insert ON admin_profiles
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR (
      NULLIF(current_setting('app.current_role', true), '') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.role = 'admin' AND ur.user_id <> admin_profiles.user_id
      )
    )
  );--> statement-breakpoint

-- Update: identical shape to practitioner_profiles_update above — see that
-- policy's comment for the full reasoning, which applies unchanged here.
CREATE POLICY admin_profiles_update ON admin_profiles
  FOR UPDATE
  USING (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  )
  WITH CHECK (
    rls_is_admin()
    OR user_id = rls_current_user_id()
    OR rls_practitioner_manages_patient(user_id)
  );--> statement-breakpoint

-- No DELETE policy — same reasoning as practitioner_profiles above.
