-- Custom SQL migration file, put your code below! --
--
-- Row-level security for the two workout tables created by 0026. Drizzle
-- can't declare policies, hence this custom migration (same split as
-- 0024 / 0025).
--
-- Each table gets EXACTLY the policies of its sibling exercise table — a
-- workout is part of the same thing its exercises are part of, so the same
-- people may read and change it:
--   - template_workouts  ↔ template_exercises (0006): everyone reads (the
--     template library is shared); only the template's owner, or an admin,
--     writes.
--   - program_workouts   ↔ assigned_program_exercises (0003, with the care
--     team rule from 0019): whoever can see the program reads (an admin, the
--     patient, their care team); an admin or the care team writes.
-- Like those tables, neither has an owner column of its own: every write
-- policy asks "does the PARENT row qualify?" with an EXISTS subquery.

-- === template_workouts =======================================================

ALTER TABLE template_workouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- FORCE: the policies apply to the table's owner too (the app's queries
-- never run as the owner, but a forgotten FORCE is how a policy silently
-- stops applying). Same as every other table.
ALTER TABLE template_workouts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY template_workouts_select ON template_workouts
  FOR SELECT USING (true);--> statement-breakpoint

CREATE POLICY template_workouts_insert ON template_workouts
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_workouts.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );--> statement-breakpoint

-- USING decides which rows an UPDATE may touch; WITH CHECK decides what they
-- may become. Both, so a workout can't be moved INTO a template that isn't
-- yours either.
CREATE POLICY template_workouts_update ON template_workouts
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_workouts.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_workouts.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );--> statement-breakpoint

CREATE POLICY template_workouts_delete ON template_workouts
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_workouts.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );--> statement-breakpoint

-- === program_workouts ========================================================

ALTER TABLE program_workouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_workouts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- "Can I see the parent program?" — assigned_programs' own policies filter
-- the subquery, so this reads exactly the workouts of programs the caller
-- may see (an admin, the patient, their care team).
CREATE POLICY program_workouts_select ON program_workouts
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_workouts.assigned_program_id
    )
  );--> statement-breakpoint

CREATE POLICY program_workouts_insert ON program_workouts
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_workouts.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

CREATE POLICY program_workouts_update ON program_workouts
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_workouts.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_workouts.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

CREATE POLICY program_workouts_delete ON program_workouts
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_workouts.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );