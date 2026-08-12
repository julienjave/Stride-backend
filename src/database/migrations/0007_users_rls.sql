-- Reuses rls_is_admin(), rls_current_user_id(), and
-- rls_practitioner_manages_patient(), all defined in
-- 0003_assigned_programs_rls.sql — no new function needed.
-- rls_practitioner_manages_patient() never actually checks the target row's
-- role (it's pure clinic-overlap, mirroring UsersService.isPatientManagedBy()
-- exactly), so it's reused here directly with the target user's own id —
-- the same call UsersController already makes as isPatientManagedBy(id,
-- currentUser.id) against a user profile, not just an assigned-program's
-- patientId.
--
-- users is structurally different from every table before it in this
-- rollout, in three ways:

ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- 1. Read: unconditionally open, and NOT for the same "no clinical
-- sensitivity" reason as exercises_select/program_templates_select. This is
-- load-bearing, not a placeholder: AuthService.findByEmailWithHash() queries
-- users with no currentUser available at all — it runs during login itself,
-- before any session exists. A restrictive SELECT policy here would break
-- login permanently for every account. This means, unlike every other table
-- in the rollout, RLS provides no read-side defense-in-depth on users —
-- UsersController's own isSelf/isAdmin/isManagingPractitioner checks remain
-- the only real read-side authorization for this table.
CREATE POLICY users_select ON users
  FOR SELECT USING (true);--> statement-breakpoint

-- 2. Insert: deliberately coarse. A user's role is inserted into the
-- separate user_roles table in the same transaction, never as a column on
-- users itself, so a WITH CHECK on users can't see it and can't encode "a
-- practitioner may only create patients" — that finer, role-appropriate
-- rule stays enforced solely by UsersService.create()'s existing app-layer
-- check. This policy only draws the coarse boundary: admin or practitioner
-- may insert into users at all.
--
-- 3. The third branch is for the two genuinely unauthenticated call sites:
-- AuthService.register() (public self-signup) and AuthService.registerClinic()
-- (the one-time founding-admin bootstrap, which inserts into users directly,
-- never through UsersService.create()). Neither has a currentUser to set as
-- session context. This is not a new exposure — POST /auth/register is
-- already a fully public, unauthenticated HTTP endpoint today; this policy
-- is just declining to add a database-level check on top of two flows that
-- were always meant to be reachable with no session.
--
-- NULLIF(..., '') IS NULL, not a plain IS NULL — confirmed directly against
-- real pooled-connection behavior, not assumed: current_setting('app.x',
-- true) is genuinely NULL only on a connection that has NEVER once run
-- set_config('app.x', ..., true) in its session lifetime. The moment any
-- OTHER request on that same pooled connection sets real session context
-- (any withRlsContext call) and its transaction commits, Postgres reverts
-- the placeholder GUC to '' (empty string), not back to NULL — is_local
-- reverts to the value the GUC held before that transaction started, and
-- once a custom GUC has been instantiated at all, its "off" baseline is ''.
-- Under a connection pool, a truly virgin connection is the exception, not
-- the rule, so a bare IS NULL check here would make this branch fire almost
-- never — a bug that produced 401s across nearly every e2e suite (register()
-- failing in beforeAll) until caught here. The app itself only ever sets
-- this to 'admin'/'practitioner'/'patient', never '', so treating '' the
-- same as NULL is unambiguous.
CREATE POLICY users_insert ON users
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR current_setting('app.current_role', true) = 'practitioner'
    OR NULLIF(current_setting('app.current_role', true), '') IS NULL
  );--> statement-breakpoint

-- Deliberately the BROADER of update()'s/softDelete()'s and
-- uploadAvatar()'s two real rules — update()/softDelete() allow
-- self-or-admin-or-managing-practitioner; uploadAvatar() allows only
-- self-or-admin, with no managing-practitioner branch. One UPDATE policy
-- per table can't distinguish which method issued the statement, so it has
-- to cover the loosest legitimate case here. uploadAvatar()'s narrower
-- restriction stays enforced only by the controller — the same "RLS
-- enforces the structural boundary, the app enforces the finer business
-- rule" principle already used for messages_update.
CREATE POLICY users_update ON users
  FOR UPDATE
  USING (
    rls_is_admin()
    OR id = rls_current_user_id()
    OR rls_practitioner_manages_patient(id)
  )
  WITH CHECK (
    rls_is_admin()
    OR id = rls_current_user_id()
    OR rls_practitioner_manages_patient(id)
  );--> statement-breakpoint

-- No DELETE policy — users are soft-deleted only (isActive), matching the
-- ON DELETE RESTRICT design used elsewhere in this schema specifically to
-- prevent a hard delete of a user row. There is no DELETE route or service
-- method for users. Under FORCE ROW LEVEL SECURITY with no DELETE policy,
-- any DELETE is rejected outright, for every role including admin.
