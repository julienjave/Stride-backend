-- Custom SQL migration file, put your code below! --
--
-- What Drizzle can't declare for program_schedules (created by 0024):
--   1. the CHECK that `weekdays` is a valid weekday SET;
--   2. the row-level security policies.
--
-- === 1. The weekday set ======================================================
--
-- `weekdays` must be ISO weekdays (1 = Monday … 7 = Sunday), sorted, without
-- duplicates, and not empty: {1,3,5}, never {5,1,3}, {1,1,3}, {0,8} or {}.
-- Keeping ONE spelling per set means two schedules are equal exactly when
-- their arrays are equal, and nothing reading the table has to clean values
-- up first. (The API sorts the days before saving; this is the guarantee
-- behind it, for any code path — or any hand-written query — that forgets.)
--
-- A CHECK constraint can't contain a subquery, and "sorted, no duplicates"
-- needs to look at the elements one by one. A function can, and a CHECK may
-- call a function — as long as it's IMMUTABLE: same input, same answer,
-- forever, reading no table. Postgres takes our word for that, so the
-- function must really be one (this one only looks at its argument).
--
-- How it decides: rebuild the array from its own elements, keeping only
-- values 1–7, without duplicates (DISTINCT), in order (ORDER BY), and compare
-- with the original. They're equal only if nothing was dropped (all in
-- range — a NULL element is dropped too, since NULL BETWEEN 1 AND 7 isn't
-- true), nothing was merged (no duplicates) and nothing moved (sorted). A
-- two-dimensional array never equals the one-dimensional rebuild.
CREATE FUNCTION is_iso_weekday_set(days smallint[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
    SELECT cardinality(days) BETWEEN 1 AND 7
      AND days = ARRAY(
        SELECT DISTINCT d FROM unnest(days) AS d
        WHERE d BETWEEN 1 AND 7
        ORDER BY d
      );
  $$;--> statement-breakpoint

-- NULL is allowed here on purpose: a 'times_per_week' row has no weekdays,
-- and program_schedules_fields_match_type (0024) already decides when
-- weekdays must be present.
ALTER TABLE program_schedules
  ADD CONSTRAINT program_schedules_weekdays_valid
  CHECK (weekdays IS NULL OR is_iso_weekday_set(weekdays));--> statement-breakpoint

-- === 2. Row-level security ===================================================
--
-- Same people as the program itself (0003): read — an admin, the patient,
-- their care team; write — an admin or the care team. Like
-- assigned_program_exercises, the table has no patient_id of its own: every
-- policy asks "does the parent assigned_programs row qualify?". For SELECT
-- that's simply "can I see the parent?" — assigned_programs' own FORCE ROW
-- LEVEL SECURITY filters the subquery to programs the caller may see.
ALTER TABLE program_schedules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_schedules FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY program_schedules_select ON program_schedules
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_schedules.assigned_program_id
    )
  );--> statement-breakpoint

-- Two more rules on top of "admin or care team":
--   - A version is always recorded as set by whoever set it: created_by
--     must be the current user (the same rule invitations use for
--     invited_by), so "changed by Sam" can't be written by someone else.
--   - No BACKDATED version. A new version starting last week would change
--     how last week is judged just as surely as deleting the old one — so
--     the same "yesterday in UTC" limit as the DELETE policy below applies
--     (see there for why yesterday). The one exception is the program's
--     START DATE, where the first version always goes (a program can be
--     assigned with a start date in the past — recording a program that
--     began last week). That exception can't open a back door: a second
--     version on that same past day would collide with the first (one
--     version per day), and the first can't be deleted once it's in the
--     past.
CREATE POLICY program_schedules_insert ON program_schedules
  FOR INSERT
  WITH CHECK (
    created_by = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_schedules.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
        AND (
          program_schedules.effective_from >= (now() AT TIME ZONE 'UTC')::date - 1
          OR program_schedules.effective_from = ap.start_date
        )
    )
  );--> statement-breakpoint

-- No UPDATE policy: under FORCE ROW LEVEL SECURITY that refuses every
-- UPDATE, for every role. A version is never edited in place.
--
-- DELETE exists for one purpose: setting a schedule "from day D" REPLACES
-- every version starting on D or later (a same-day correction, or a change
-- that was planned for later and is now superseded). Those versions haven't
-- governed any past day yet, so removing them loses no history. The policy
-- makes that a DATABASE guarantee, not just the service's habit: only
-- versions starting yesterday (UTC) or later can be deleted, so a version
-- that judged last week can't disappear, whatever query is sent.
--
-- Why yesterday, not today: the database only knows UTC's date, and the
-- practitioner's own "today" can be one day behind it (21:00 in Montreal is
-- already tomorrow in UTC). Every time zone's date is within one day of
-- UTC's, so yesterday-in-UTC is the earliest "today" anyone can have.
CREATE POLICY program_schedules_delete ON program_schedules
  FOR DELETE
  USING (
    effective_from >= (now() AT TIME ZONE 'UTC')::date - 1
    AND EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_schedules.assigned_program_id
        AND (rls_is_admin() OR rls_practitioner_manages_patient(ap.patient_id))
    )
  );