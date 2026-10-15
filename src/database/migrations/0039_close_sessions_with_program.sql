-- Custom SQL migration (Phase 4 step 1b, decided with the person 2026-10-15):
-- closing a program closes its open sessions. "An open session in a closed
-- program makes no sense" (the person) — this replaces decision 1 of the
-- closed-program guard (0031: "a session in progress may still be
-- finished").
--
-- Sessions were the PATIENT's alone to write (0004: no admin or care-team
-- branch, at either layer). Closing a program is done by the care team or an
-- admin, in AssignedProgramsService.close()'s transaction — so they need to
-- write the open session, for that one purpose and no other:
--   1. a new UPDATE policy lets the care team and admins update a session
--      row at all (policies are permissive: this ORs with sessions_update);
--   2. the session guard (0038) is re-created with a branch for them that
--      allows exactly one change — and refuses `program_closed` from the
--      patient, so the reason always means what it says.
-- A policy says which ROWS may be updated, never which COLUMNS or VALUES:
-- the trigger, which sees OLD and NEW, is what keeps the exception narrow.
-- (The two together, rather than a SECURITY DEFINER function bypassing row
-- security: the write stays the actor's own, under their RLS context, and
-- the rule stays where every other session rule is.)
--
-- Who the care team is: rls_practitioner_manages_patient() — the same
-- function every other care-team policy uses (0019's body: an active link
-- AND a shared clinic).

CREATE POLICY sessions_update_close_with_program ON sessions
  FOR UPDATE
  USING (rls_is_admin() OR rls_practitioner_manages_patient(patient_id))
  WITH CHECK (rls_is_admin() OR rls_practitioner_manages_patient(patient_id));--> statement-breakpoint

-- The session guard of 0038, with the two NEW parts marked. CREATE OR
-- REPLACE: the trigger (session_update_guard) keeps calling it.
CREATE OR REPLACE FUNCTION guard_session_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  utc_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  -- NEW (0039): anyone but the session's patient — the care team or an
  -- admin, let through by the new UPDATE policy below — may make ONE change:
  -- close an open session because its program is closed. Exactly that:
  -- in_progress → incomplete, reason program_closed, at the database's now,
  -- nothing else touched (the whole row as JSON, minus those three fields,
  -- equal), and only once the program really is closed (read here, in the
  -- same transaction as close()'s own UPDATE of the program).
  IF current_setting('app.current_role', true) IS DISTINCT FROM 'patient' THEN
    IF NOT (
      OLD.status = 'in_progress'
      AND NEW.status = 'incomplete'
      AND NEW.end_reason = 'program_closed'
      AND NEW.ended_at = now()
      AND (to_jsonb(NEW) - 'status' - 'end_reason' - 'ended_at')
        = (to_jsonb(OLD) - 'status' - 'end_reason' - 'ended_at')
      AND EXISTS (
        SELECT 1 FROM assigned_programs ap
        WHERE ap.id = NEW.assigned_program_id
          AND (ap.status <> 'active' OR ap.is_archived)
      )
    ) THEN
      RAISE EXCEPTION 'Session % can only be closed with its program by anyone but its patient', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'session_staff_close_only',
              TABLE = TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Session % is finished, so it can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_finished',
            TABLE = TG_TABLE_NAME;
  END IF;
  IF (NEW.assigned_program_id, NEW.workout_id, NEW.patient_id, NEW.local_date,
      NEW.counts_for, NEW.started_at, NEW.scheduled_date)
     IS DISTINCT FROM
     (OLD.assigned_program_id, OLD.workout_id, OLD.patient_id, OLD.local_date,
      OLD.counts_for, OLD.started_at, OLD.scheduled_date) THEN
    RAISE EXCEPTION 'What session % is can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_identity_fixed',
            TABLE = TG_TABLE_NAME;
  END IF;
  -- NEW (0039): `program_closed` says the PROGRAM closed it — written only
  -- by closing the program (the branch above), never by the patient.
  IF NEW.end_reason = 'program_closed' THEN
    RAISE EXCEPTION 'Session % is closed with its program only by closing the program', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_program_closed_reason',
            TABLE = TG_TABLE_NAME;
  END IF;
  IF NEW.status = 'completed' THEN
    IF NEW.completed_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'Session % must be completed at the moment it is completed', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'session_moment_server_set',
              TABLE = TG_TABLE_NAME;
    END IF;
    IF NEW.local_date NOT BETWEEN utc_today - 1 AND utc_today + 1 THEN
      RAISE EXCEPTION 'Session % can only be completed on its own day', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'session_completed_on_its_day',
              TABLE = TG_TABLE_NAME;
    END IF;
  ELSIF NEW.status = 'incomplete' THEN
    IF NEW.ended_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'Session % must end at the moment it ends', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'session_moment_server_set',
              TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END
$$;