-- Reuses rls_is_admin() and rls_current_user_id(), defined in
-- 0003_assigned_programs_rls.sql — no redefinition here. Unlike every
-- prior table in this rollout, the authorship rule here is a direct
-- column comparison (created_by / practitioner_id), not a
-- clinic-membership join, so neither rls_practitioner_manages_patient()
-- nor rls_clinic_overlap() apply — no new helper needed.

ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE exercises FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: genuinely unrestricted, not role-gated — confirmed directly
-- against ExercisesService.findAll/findOne, neither of which checks
-- currentUser at all. There is no clinical sensitivity in a general
-- exercise library the way there is with medical_files/sessions/etc, and
-- patients need to see the full details of exercises assigned to them,
-- not just practitioners browsing to build a program. This is the first
-- table in the rollout with a plain USING (true) — deliberate, not a
-- placeholder.
CREATE POLICY exercises_select ON exercises
  FOR SELECT USING (true);--> statement-breakpoint

-- Create: practitioner-only, matching @Roles(UserRole.PRACTITIONER) on
-- POST /exercises — no admin branch, since no route lets an admin create
-- an exercise in the first place. source = 'custom' is enforced here too,
-- not just set server-side in ExercisesService.create(): a directly
-- issued INSERT can never claim to be an 'api'-sourced row.
CREATE POLICY exercises_insert ON exercises
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND created_by = rls_current_user_id()
    AND source = 'custom'
  );--> statement-breakpoint

-- Write (update/reorderImages/removeImage/addImages): matches
-- ExercisesService.assertCanModify() exactly — admin can modify any row;
-- a practitioner only their own custom exercises. The shared,
-- api-sourced library (source = 'api') is never practitioner-writable,
-- only admin-writable, same as the app layer.
CREATE POLICY exercises_update ON exercises
  FOR UPDATE
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND source = 'custom'
        AND created_by = rls_current_user_id())
  )
  WITH CHECK (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND source = 'custom'
        AND created_by = rls_current_user_id())
  );--> statement-breakpoint

-- No DELETE policy — archive() is a soft delete (UPDATE isArchived); the
-- app never issues a real DELETE against this table. Under FORCE ROW
-- LEVEL SECURITY with no DELETE policy, any DELETE is rejected outright,
-- for every role including admin.

ALTER TABLE program_templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_templates FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: same open-read reasoning as exercises_select — confirmed against
-- ProgramsService.findAll/findTemplateOrThrow, neither of which checks
-- currentUser. A preset library is more useful shared across the practice
-- than hidden per-practitioner, while remaining editable only by its
-- owner (or an admin).
CREATE POLICY program_templates_select ON program_templates
  FOR SELECT USING (true);--> statement-breakpoint

-- Create: practitioner-only, matching @Roles(UserRole.PRACTITIONER) on
-- POST /programs — no admin branch, same reasoning as exercises_insert.
CREATE POLICY program_templates_insert ON program_templates
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND practitioner_id = rls_current_user_id()
  );--> statement-breakpoint

-- Write (update/archive/exercise-management): matches
-- ProgramsService.assertCanModify() exactly — admin can modify any
-- template; a practitioner only templates where practitioner_id is them.
CREATE POLICY program_templates_update ON program_templates
  FOR UPDATE
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND practitioner_id = rls_current_user_id())
  )
  WITH CHECK (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND practitioner_id = rls_current_user_id())
  );--> statement-breakpoint

-- No DELETE policy — archive() is a soft delete (UPDATE isArchived); the
-- app never issues a real DELETE against this table.

ALTER TABLE template_exercises ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE template_exercises FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- No independent authorization rule of its own — always "does this
-- satisfy the parent's condition," same shape as
-- assigned_program_exercises/session_exercises before it. For SELECT
-- specifically, this is a plain USING (true), not even the "check via
-- parent" EXISTS trick every prior child table used — since the parent's
-- own visibility (program_templates_select, above) is itself
-- unconditional, checking it via subquery here would just be redundant
-- indirection: there is no row program_templates_select would hide that
-- this policy would need to hide too.
CREATE POLICY template_exercises_select ON template_exercises
  FOR SELECT USING (true);--> statement-breakpoint

-- Write (addExercise's INSERT; updateExercise's and reorderExercises'
-- UPDATE; removeExercise's DELETE): checked against the PARENT
-- program_templates row's write rule, same admin-or-owning-practitioner
-- condition as program_templates_update, not program_templates_select.
CREATE POLICY template_exercises_insert ON template_exercises
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_exercises.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );--> statement-breakpoint

CREATE POLICY template_exercises_update ON template_exercises
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_exercises.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_exercises.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );--> statement-breakpoint

-- Unlike program_templates itself, removeExercise() DOES issue a real
-- DELETE — this table needs an actual DELETE policy, not just the
-- "no policy = no deletes" default the parent relies on. Same shape as
-- assigned_program_exercises_delete.
CREATE POLICY template_exercises_delete ON template_exercises
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM program_templates pt
      WHERE pt.id = template_exercises.template_id
        AND (rls_is_admin()
             OR (current_setting('app.current_role', true) = 'practitioner'
                 AND pt.practitioner_id = rls_current_user_id()))
    )
  );
