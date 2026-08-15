-- Reuses rls_is_admin(), defined in 0003_assigned_programs_rls.sql — no new
-- helper needed. clinics has no ownership concept of its own beyond "is the
-- caller an admin" (confirmed directly against clinics.controller.ts/
-- clinics.service.ts: create/uploadLogo/update/deactivate are gated only by
-- @Roles(UserRole.ADMIN), with no clinic-membership or authorship check
-- anywhere in ClinicsService), so unlike exercises/program_templates there
-- is no practitioner-owner branch here at all.
--
-- Scope check beyond ClinicsService, same discipline the original rollout
-- applied (SessionsService touching assigned_programs, AuthService writing
-- to users directly): AuthService.registerClinic() also writes directly to
-- clinics, outside ClinicsService entirely — see clinics_insert below.

ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinics FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: genuinely unrestricted — confirmed directly against
-- ClinicsService.findAll/findOne/exists, none of which checks currentUser at
-- all, matching doc 05's framing of clinics as branding/display data with
-- "no access-control power of its own." Same shape as exercises_select/
-- program_templates_select, not a placeholder.
CREATE POLICY clinics_select ON clinics
  FOR SELECT USING (true);--> statement-breakpoint

-- Create: admin-only for POST /clinics (@Roles(UserRole.ADMIN), matching
-- ClinicsService.create()) — PLUS a bootstrap branch for
-- AuthService.registerClinic(), which inserts directly into clinics
-- (never through ClinicsService, confirmed as the ONLY other write call
-- site into this table anywhere in src/ or scripts/) inside a plain
-- db.transaction() with no session to set app.current_role from, since
-- it's the genuinely unauthenticated founding-admin bootstrap —
-- POST /auth/register-clinic is reachable with no session at all. Caught
-- by adversarial e2e verification, not assumed: an initial version of this
-- policy without any bootstrap branch broke registerClinic() outright.
--
-- Deliberately NOT the users_insert-shaped "no context at all" branch
-- (NULLIF(current_setting(...), '') IS NULL) despite the identical-looking
-- problem — that shape is right for users_insert (registration is legitimate
-- for the lifetime of the app, not just once), but wrong here: it would
-- permit ANY insert from ANY code path with no RLS context set, forever,
-- not just registerClinic()'s one real, time-bounded case. Matched
-- instead to this table's actual invariant — registerClinic()'s own
-- business gate, "does an admin already exist" (auth.service.ts) — via
-- NOT EXISTS, so the exception closes itself the moment it stops being
-- true, rather than staying open indefinitely. Confirmed adversarially,
-- not just reasoned about: with a real admin row deleted inside an
-- uncommitted, rolled-back transaction (simulating the genuine pre-
-- bootstrap state), a no-context INSERT succeeds; with a real admin
-- present and no context set — the one scenario a stray unwrapped INSERT
-- elsewhere would produce — it's rejected. The broad NULLIF version would
-- have silently allowed that second case forever; this doesn't.
CREATE POLICY clinics_insert ON clinics
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
  );--> statement-breakpoint

-- Write (update/uploadLogo/deactivate): admin-only, matching
-- @Roles(UserRole.ADMIN) on PATCH /clinics/:id, POST /clinics/:id/logo, and
-- DELETE /clinics/:id (deactivate() is a soft delete via UPDATE isActive,
-- not a real DELETE).
CREATE POLICY clinics_update ON clinics
  FOR UPDATE
  USING (rls_is_admin())
  WITH CHECK (rls_is_admin());--> statement-breakpoint

-- No DELETE policy — there is no real DELETE route on clinics at all;
-- deactivate() only ever issues an UPDATE. Under FORCE ROW LEVEL SECURITY
-- with no DELETE policy, any DELETE is rejected outright, for every role
-- including admin — a correct, deliberate safety property here (nothing in
-- the app ever needs a real DELETE against this table to work), not an
-- omission.
