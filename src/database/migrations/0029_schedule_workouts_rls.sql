-- Custom SQL migration file, put your code below! --
--
-- What Drizzle can't declare for step 2b-ii (0028 created the tables):
--   1. the row-level security of program_schedule_days and
--      program_schedule_rotation;
--   2. dropping is_iso_weekday_set(), which only guarded the old `weekdays`
--      array (0025) — 0028 dropped the column and its CHECK.
--
-- === 1. Row-level security ===================================================
--
-- The children of a schedule version follow the version itself (0025):
--   - READ: whoever can see the version — and program_schedules' own
--     policies decide that (an admin, the patient, their care team), so the
--     subquery below only finds versions the caller may see.
--   - INSERT: only together with the version, in the SAME transaction, by
--     the same person — see the policy's comment.
--   - No UPDATE, no DELETE policy: under FORCE ROW LEVEL SECURITY nobody can
--     edit or delete a day or a rotation position directly. They disappear
--     only with their version (ON DELETE CASCADE, when a version is replaced
--     "from D on" — a cascade is carried out by the foreign key itself, not
--     by a DELETE statement the policies would judge).
--
-- So a version and its days are written once, together, and never changed:
-- the history guarantee 0025 gave the versions now covers their contents.

ALTER TABLE program_schedule_days ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_schedule_days FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY program_schedule_days_select ON program_schedule_days
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM program_schedules ps
      WHERE ps.id = program_schedule_days.schedule_id
    )
  );--> statement-breakpoint

-- Only in the transaction that created the version. `now()` is the start
-- time of the CURRENT transaction — the same value for every statement in
-- it — and created_at was set to now() (its default) when the version was
-- inserted. Equal means "this version was created by this transaction";
-- a version created yesterday, or a minute ago in another request, has an
-- earlier created_at, and its days can't be added to. Without it, a
-- practitioner could add Tuesday to last month's version and change how
-- last month is judged — exactly what 0025 forbids for the versions
-- themselves. Plus the version's own rules: created by the current user,
-- and the caller an admin or on the care team.
CREATE POLICY program_schedule_days_insert ON program_schedule_days
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_schedules ps
      JOIN assigned_programs ap ON ap.id = ps.assigned_program_id
      WHERE ps.id = program_schedule_days.schedule_id
        AND ps.created_at = now()
        AND ps.created_by = rls_current_user_id()
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

ALTER TABLE program_schedule_rotation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_schedule_rotation FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY program_schedule_rotation_select ON program_schedule_rotation
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM program_schedules ps
      WHERE ps.id = program_schedule_rotation.schedule_id
    )
  );--> statement-breakpoint

-- Same rule as the days: only with the version, in its transaction.
CREATE POLICY program_schedule_rotation_insert ON program_schedule_rotation
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_schedules ps
      JOIN assigned_programs ap ON ap.id = ps.assigned_program_id
      WHERE ps.id = program_schedule_rotation.schedule_id
        AND ps.created_at = now()
        AND ps.created_by = rls_current_user_id()
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );--> statement-breakpoint

-- === 2. The old weekday-set function ==========================================
--
-- Nothing uses it any more: a version's days are now rows, and "1–7, no
-- duplicates" is a CHECK plus the primary key (schedule_id, weekday).
DROP FUNCTION is_iso_weekday_set(smallint[]);