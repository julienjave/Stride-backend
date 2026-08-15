-- Reuses rls_is_admin() and rls_practitioner_manages_patient(), both defined
-- in 0003_assigned_programs_rls.sql — no new helper needed.
-- rls_practitioner_manages_patient(target_patient_id) is reused directly
-- against user_roles.user_id, the same way 0007_users_rls.sql reuses it
-- against users.id: it's pure clinic-overlap and never inspects the
-- target's own role, so it works unchanged here.
--
-- Scope check beyond the roadmap's own starting list, done the same way
-- every prior pass did it (grep the whole tree, not just what the plan
-- named up front): six real call sites touch user_roles, not four.
-- Two extra SELECTs turned up: ClinicsService.listMembers() (admin-only
-- route, attaches each clinic member's roles) and
-- UsersService.findPatientsForPractitioner() (joins user_roles to filter
-- to role = 'patient'). Neither needed any code change — see the SELECT
-- policy note below on why — but both are real, confirmed traffic against
-- this table and are named here so this comment doesn't undercount scope
-- the way the roadmap's own opening summary did.

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: genuinely unrestricted, for the SAME load-bearing reason as
-- users_select in 0007, not a lighter "no sensitivity" call like
-- clinics_select. UsersService.getRolesForUser(userId) is called from
-- AuthService.validateUser() — the login path itself — with NO RLS
-- context: getRolesForUser always queries via `this.db`, never a `tx`, so
-- it never carries whatever session context an outer withRlsContext call
-- might have set. This isn't a plumbing oversight to fix; it's the same
-- structural fact users_select was written around (findByEmailWithHash()
-- also runs pre-session), just one level removed.
--
-- A narrower self-or-admin-or-managing-practitioner policy (the shape
-- this table's read rule would otherwise mirror, matching users_update)
-- was drafted and adversarially tested before being rejected — not
-- assumed to fail. With that policy live and a real patient row seeded,
-- querying user_roles as stride_app with zero session context set (the
-- exact shape of getRolesForUser's call inside validateUser()) returned
-- ZERO rows for that patient. Concretely: `roles` comes back `[]` for
-- every patient/practitioner login, which validateUser() then turns into
-- either a wrong 403 ("account does not have that role", if the client
-- passed requestedRole) or a wrong 400 ("account has multiple roles",
-- since 0 !== 1) — login broken for every non-admin account, not a
-- narrow edge case. A no-context branch scoped to `role = 'admin'` only
-- (the shape that correctly serves registerClinic()'s bootstrap check,
-- confirmed separately below) does NOT cover this, since the row
-- getRolesForUser needs during a patient or practitioner login is
-- neither self-provable (no session exists yet to compare against) nor
-- role = 'admin'.
--
-- The alternative — thread real/synthetic session context through every
-- getRolesForUser call site instead of loosening the policy — was
-- rejected too, not skipped: unlike forgotPassword()/resetPassword()
-- (0007's own precedent for a synthetic self-context), validateUser()
-- calls getRolesForUser() BEFORE activeRole is known at all, which is
-- circular — the role is the very thing being looked up, so there is no
-- role value yet to put in the context that would let a narrower policy
-- admit the row. Solvable in principle (a user-id-only context variant of
-- withRlsContext, since the self-branch of a narrower policy only needs
-- app.current_user_id, never app.current_role), but that's real new
-- surface for a table where the ceiling on what it would even protect is
-- low: users_select already leaves the far more sensitive users row
-- (email, name, avatar, mfaEnabled) fully open to any stride_app
-- connection with no RLS read defense at all. A row that only ever says
-- "this user_id holds this role" is a strictly smaller disclosure than
-- what's already unconditionally open one table over — not worth adding
-- a genuinely new mechanism to partially gate. UsersController's existing
-- isSelf/isAdmin/isManagingPractitioner checks remain the only real
-- read-side authorization here, same as users_select's own conclusion.
CREATE POLICY user_roles_select ON user_roles
  FOR SELECT USING (true);--> statement-breakpoint

-- Insert: three real branches, distinguished by WHICH role is being
-- inserted, not just whether a session exists — unlike users_insert,
-- which couldn't see the target role at all (it lives in this sibling
-- table, not a column on users itself). Here the role being written IS a
-- column on the row this policy governs, so WITH CHECK can reference it
-- directly.
--
-- 1. Real admin session: any role, any user — matches grantRole()'s own
--    @Roles(UserRole.ADMIN) gate (admin can grant any role to anyone) and
--    the admin branch of create()'s practitioner-or-admin gate.
-- 2. Real practitioner session: role = 'patient' only — mirrors
--    UsersService.create()'s own existing check
--    ("Practitioners can only create patient accounts"), enforced here a
--    second time at the DB layer, not merely restated.
-- 3. No context at all: covers the two genuinely unauthenticated
--    bootstrap inserts, which need DIFFERENT conditions under the same
--    umbrella, not one shared rule —
--      - AuthService.register() → UsersService.create(), always
--        role = 'patient', always allowed. Confirmed as the only
--        no-context path that can reach this insert: RegisterDto has no
--        role field at all; AuthService.register() hardcodes
--        `role: UserRole.PATIENT` regardless of request body, so an
--        unauthenticated caller can never make this branch insert
--        anything but 'patient'.
--      - AuthService.registerClinic(), always role = 'admin', gated by
--        NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') —
--        the same bootstrap invariant clinics_insert's own no-context
--        branch already checks (0008), applied here directly against
--        this table instead of borrowed from it. This subquery is itself
--        subject to user_roles_select, which is `USING (true)` above, so
--        it always sees every existing admin row regardless of the
--        inserting connection's own context — same reasoning that makes
--        clinics_insert's identical subquery (querying THIS table) keep
--        working once user_roles carries its own FORCE'd RLS for the
--        first time.
--
-- role = 'practitioner' is deliberately reachable by NEITHER the
-- practitioner-session branch (2) nor the no-context branch (3) — there
-- is no real call site that ever inserts a practitioner role with no
-- session (grantRole() is admin-only; create() is practitioner-or-admin
-- gated, but a practitioner session inserting role='practitioner' isn't a
-- real flow either, and branch 2 above only opens role='patient']).
CREATE POLICY user_roles_insert ON user_roles
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR (
      current_setting('app.current_role', true) = 'practitioner'
      AND role = 'patient'
    )
    OR (
      NULLIF(current_setting('app.current_role', true), '') IS NULL
      AND (
        role = 'patient'
        OR (
          role = 'admin'
          AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
        )
      )
    )
  );--> statement-breakpoint

-- No UPDATE or DELETE policy — confirmed by a fresh grep across src/
-- (not just trusted from the roadmap's own note) that no code path ever
-- issues either against user_roles: roles are only ever added, never
-- changed or removed in place. Under FORCE ROW LEVEL SECURITY with no
-- policy for a given command, that command is rejected outright for
-- every role, including admin — correct here, since nothing in the app
-- ever needs a real UPDATE or DELETE against this table to work.
