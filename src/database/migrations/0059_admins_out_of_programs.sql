-- Phase 6, privacy and security pass 1 (decisions §16, 2026-10-23): admins
-- read and change NO patient program and NO session — the same line already
-- drawn for messages (0048) and medical files (0050). An admin runs clinics
-- and accounts; clinical access comes only with the practitioner role and a
-- place on the patient's care team (rls_practitioner_manages_patient checks
-- the ACTIVE role, so a practitioner + admin account acting as admin gets
-- nothing through it either).
--
-- ALTER POLICY replaces a policy's expressions in place (its name, command
-- and roles stay): each statement below is the policy as it was, minus its
-- `rls_is_admin() OR` branch. The child tables' SELECT policies
-- (program_schedules, program_workouts, assigned_program_exercises,
-- session_exercises, the schedule days and rotation) read through the
-- parent's visibility — `EXISTS (SELECT 1 FROM assigned_programs …)` itself
-- runs under assigned_programs' SELECT policy — so they follow without a
-- change.
--
-- The same is true of the WRITE policies' admin branches below: an UPDATE or
-- DELETE only reaches rows the SELECT policy shows, and every EXISTS reads
-- the program through its SELECT policy — so once an admin sees no program
-- and no session, those branches could never be used. They are removed all
-- the same, so each policy says what it means (defence in depth); the
-- mutation run found each one, put back alone, changes nothing an admin can
-- do (equivalent), while putting the SELECT branches back is caught.

-- --- assigned_programs ------------------------------------------------------

ALTER POLICY assigned_programs_select ON assigned_programs
  USING (
    (current_setting('app.current_role', true) = 'patient' AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );
--> statement-breakpoint
ALTER POLICY assigned_programs_insert ON assigned_programs
  WITH CHECK (rls_practitioner_manages_patient(patient_id));
--> statement-breakpoint
ALTER POLICY assigned_programs_update ON assigned_programs
  USING (rls_practitioner_manages_patient(patient_id))
  WITH CHECK (rls_practitioner_manages_patient(patient_id));
--> statement-breakpoint

-- --- assigned_program_exercises ---------------------------------------------

ALTER POLICY assigned_program_exercises_insert ON assigned_program_exercises
  WITH CHECK (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = assigned_program_exercises.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY assigned_program_exercises_update ON assigned_program_exercises
  USING (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = assigned_program_exercises.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = assigned_program_exercises.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY assigned_program_exercises_delete ON assigned_program_exercises
  USING (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = assigned_program_exercises.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint

-- --- program_workouts -------------------------------------------------------

ALTER POLICY program_workouts_insert ON program_workouts
  WITH CHECK (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = program_workouts.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY program_workouts_update ON program_workouts
  USING (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = program_workouts.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = program_workouts.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY program_workouts_delete ON program_workouts
  USING (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = program_workouts.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint

-- --- program_schedules and their children -----------------------------------
-- The date and author rules (0025, 0029) are kept exactly; only the admin
-- branch goes.

ALTER POLICY program_schedules_insert ON program_schedules
  WITH CHECK (
    created_by = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_schedules.assigned_program_id
        AND rls_practitioner_manages_patient(ap.patient_id)
        AND (
          program_schedules.effective_from >= ((now() AT TIME ZONE 'UTC')::date - 1)
          OR program_schedules.effective_from = ap.start_date
        )
    )
  );
--> statement-breakpoint
ALTER POLICY program_schedules_delete ON program_schedules
  USING (
    effective_from >= ((now() AT TIME ZONE 'UTC')::date - 1)
    AND EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_schedules.assigned_program_id
        AND rls_practitioner_manages_patient(ap.patient_id)
    )
  );
--> statement-breakpoint
ALTER POLICY program_schedule_days_insert ON program_schedule_days
  WITH CHECK (EXISTS (
    SELECT 1 FROM program_schedules ps
    JOIN assigned_programs ap ON ap.id = ps.assigned_program_id
    WHERE ps.id = program_schedule_days.schedule_id
      AND ps.created_at = now()
      AND ps.created_by = rls_current_user_id()
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY program_schedule_rotation_insert ON program_schedule_rotation
  WITH CHECK (EXISTS (
    SELECT 1 FROM program_schedules ps
    JOIN assigned_programs ap ON ap.id = ps.assigned_program_id
    WHERE ps.id = program_schedule_rotation.schedule_id
      AND ps.created_at = now()
      AND ps.created_by = rls_current_user_id()
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));
--> statement-breakpoint

-- --- sessions and what is said about them -----------------------------------

ALTER POLICY sessions_select ON sessions
  USING (
    (current_setting('app.current_role', true) = 'patient' AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );
--> statement-breakpoint
-- Closing a program closes its open sessions (0039): now only the care team
-- closes a program, so only the care team needs this door.
ALTER POLICY sessions_update_close_with_program ON sessions
  USING (rls_practitioner_manages_patient(patient_id))
  WITH CHECK (rls_practitioner_manages_patient(patient_id));
--> statement-breakpoint
ALTER POLICY session_reviews_select ON session_reviews
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_reviews.session_id
      AND rls_practitioner_manages_patient(s.patient_id)
  ));
--> statement-breakpoint
ALTER POLICY program_alert_reviews_select ON program_alert_reviews
  USING (EXISTS (
    SELECT 1 FROM assigned_programs ap
    WHERE ap.id = program_alert_reviews.assigned_program_id
      AND rls_practitioner_manages_patient(ap.patient_id)
  ));