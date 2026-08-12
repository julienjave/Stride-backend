-- Reuses rls_is_admin(), rls_current_user_id(), and
-- rls_practitioner_manages_patient() defined in 0003_assigned_programs_rls.sql
-- — no redefinition here.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: admin sees any row, the owning patient sees their own, a
-- practitioner sees any patient they manage — identical shape to
-- assigned_programs_select.
CREATE POLICY sessions_select ON sessions
  FOR SELECT
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'patient'
        AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- Write: the owning patient ONLY — deliberately no rls_is_admin() or
-- rls_practitioner_manages_patient() branch at all, unlike every other
-- table in this rollout so far. This mirrors SessionsService.assertIsOwner()
-- exactly ("No practitioner/admin branch at all — sessions are patient-only
-- to modify, full stop"): a managing practitioner or admin can SEE a
-- session via the SELECT policy above, but can never write to it, at
-- either the app layer or here.
CREATE POLICY sessions_insert ON sessions
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'patient'
    AND patient_id = rls_current_user_id()
  );--> statement-breakpoint

CREATE POLICY sessions_update ON sessions
  FOR UPDATE
  USING (
    current_setting('app.current_role', true) = 'patient'
    AND patient_id = rls_current_user_id()
  )
  WITH CHECK (
    current_setting('app.current_role', true) = 'patient'
    AND patient_id = rls_current_user_id()
  );--> statement-breakpoint

-- No DELETE policy — there is no DELETE route or service method for
-- sessions. Under FORCE ROW LEVEL SECURITY with no DELETE policy, any
-- DELETE is rejected outright, for every role including admin.

ALTER TABLE session_exercises ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE session_exercises FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- No patient_id of its own — visibility is always "does the parent
-- sessions row satisfy the relevant condition," never re-derived
-- independently, same shape as assigned_program_exercises. For SELECT,
-- this relies on sessions' own FORCE ROW LEVEL SECURITY already filtering
-- the subquery to rows the caller can see: if you can see the session, you
-- see its exercises.
--
-- sessions.id is bigserial and session_exercises.session_id is bigint —
-- same width, so this comparison needs no explicit cast.
CREATE POLICY session_exercises_select ON session_exercises
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_exercises.session_id)
  );--> statement-breakpoint

-- Write: checked against sessions' narrower write rule (owning patient
-- only), not assigned_programs' manager rule — no rls_is_admin() or
-- rls_practitioner_manages_patient() branch here either, for the same
-- reason as sessions_insert/sessions_update above.
CREATE POLICY session_exercises_insert ON session_exercises
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_exercises.session_id
        AND current_setting('app.current_role', true) = 'patient'
        AND s.patient_id = rls_current_user_id()
    )
  );--> statement-breakpoint

CREATE POLICY session_exercises_update ON session_exercises
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_exercises.session_id
        AND current_setting('app.current_role', true) = 'patient'
        AND s.patient_id = rls_current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_exercises.session_id
        AND current_setting('app.current_role', true) = 'patient'
        AND s.patient_id = rls_current_user_id()
    )
  );--> statement-breakpoint

-- No DELETE policy — there is no DELETE route or service method for
-- session_exercises either (rows live and die with their parent session,
-- via ON DELETE CASCADE, and there is no DELETE route on sessions to
-- trigger that in the first place).
