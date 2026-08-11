-- Shared helper functions for the RLS rollout — this clinic-membership /
-- role-check pattern is about to recur across several more tables, so it's
-- defined once here rather than inlined into every policy that needs it.
--
-- rls_practitioner_manages_patient() mirrors UsersService.isPatientManagedBy()
-- (src/users/users.service.ts) exactly — TypeScript there, SQL here, both
-- encoding the identical clinic-membership rule, with no automatic check
-- keeping them in sync. A future change to either one needs the other
-- checked too. RLS can only narrow what a query returns, never broaden it,
-- so a drift here would fail silently: rows would just start going quietly
-- missing for a practitioner, never throw an error.
CREATE FUNCTION rls_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.current_role', true) = 'admin';
  $$;--> statement-breakpoint

CREATE FUNCTION rls_current_user_id() RETURNS integer
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.current_user_id', true)::integer;
  $$;--> statement-breakpoint

CREATE FUNCTION rls_practitioner_manages_patient(target_patient_id integer)
  RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.current_role', true) = 'practitioner'
      AND EXISTS (
        SELECT 1
        FROM user_clinics uc_practitioner
        JOIN user_clinics uc_patient
          ON uc_practitioner.clinic_id = uc_patient.clinic_id
        WHERE uc_practitioner.user_id = current_setting('app.current_user_id', true)::integer
          AND uc_patient.user_id = target_patient_id
      );
  $$;--> statement-breakpoint

ALTER TABLE assigned_programs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assigned_programs FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: admin sees any row, the owning patient sees their own, a
-- practitioner sees any patient they manage.
CREATE POLICY assigned_programs_select ON assigned_programs
  FOR SELECT
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'patient'
        AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- Write: admin or a managing practitioner only — deliberately NOT
-- "read rule filtered by role". The owning patient is excluded here even
-- though they pass the SELECT policy above; AssignedProgramsService.
-- assertCanManage() enforces the same exclusion at the app layer, so the
-- two are expected to agree, not just happen to.
CREATE POLICY assigned_programs_insert ON assigned_programs
  FOR INSERT
  WITH CHECK (rls_is_admin() OR rls_practitioner_manages_patient(patient_id));--> statement-breakpoint

CREATE POLICY assigned_programs_update ON assigned_programs
  FOR UPDATE
  USING (rls_is_admin() OR rls_practitioner_manages_patient(patient_id))
  WITH CHECK (rls_is_admin() OR rls_practitioner_manages_patient(patient_id));--> statement-breakpoint

-- No DELETE policy — archive() is a soft delete (UPDATE isArchived); the
-- app never issues a real DELETE against this table. Under FORCE ROW LEVEL
-- SECURITY with no DELETE policy defined, any DELETE is rejected outright,
-- for every role including admin.

ALTER TABLE assigned_program_exercises ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assigned_program_exercises FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- This table has no patient_id of its own — its visibility is always
-- "does the parent assigned_programs row satisfy the relevant condition,"
-- never re-derived independently. For SELECT specifically, this relies on
-- assigned_programs' own FORCE ROW LEVEL SECURITY already filtering the
-- subquery below to rows the caller can see — if you can see the program,
-- you see its exercises, deliberately not re-checking role/ownership here.
CREATE POLICY assigned_program_exercises_select ON assigned_program_exercises
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = assigned_program_exercises.assigned_program_id
    )
  );--> statement-breakpoint

CREATE POLICY assigned_program_exercises_insert ON assigned_program_exercises
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = assigned_program_exercises.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

CREATE POLICY assigned_program_exercises_update ON assigned_program_exercises
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = assigned_program_exercises.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = assigned_program_exercises.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

-- Unlike the parent table, removeExercise() DOES issue a real DELETE —
-- this table needs an actual DELETE policy, not just the "no policy = no
-- deletes" default the parent relies on.
CREATE POLICY assigned_program_exercises_delete ON assigned_program_exercises
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = assigned_program_exercises.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );
