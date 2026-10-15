-- Custom SQL migration (Phase 4 step 1a, decided with the person
-- 2026-10-15): the database's half of the session rules. The service follows
-- them too (session-rules.ts); these make them hold for ANY query under the
-- app's role — a future route that forgets, a direct query — the "every rule
-- exists twice" approach of 0031 and 0033, built the same way:
--   - BEFORE triggers, because the rules compare the row BEFORE (OLD) and
--     AFTER (NEW) a change, which neither a CHECK (it sees one row) nor a
--     policy (its WITH CHECK sees only the new row) can do. 0037's CHECKs
--     already say what each status's row looks like; these say which
--     CHANGES are allowed.
--   - Only the APP is guarded. The tables' OWNER (migrations, the dev seed,
--     the e2e tests' set-up) is exempt, found from the catalog — no role name
--     written here (0031 explains why).
--   - A refusal is SQLSTATE 23514 (check_violation) with a CONSTRAINT name,
--     the shape isCheckViolation() (pg-errors.ts) recognises;
--     HttpExceptionFilter turns each into the service's own 409.

-- === 1. A session: only an open one changes, and only forward ================
--
-- The rules:
--   - A FINISHED session (completed, incomplete, skipped) never changes —
--     not its status, not its pain values, not its feedback. Finality is
--     what makes the record trustworthy: the summary judges the schedule
--     from completed sessions, and judged history isn't rewritten.
--   - What a session IS never changes: its program, workout, patient, day,
--     the day it counts for, when it started, when its row was created.
--   - Changing status: in_progress → completed or incomplete. (→ skipped is
--     impossible already: a skip has no start, and the start can't change;
--     → in_progress from a finished one is the first rule.)
--   - Its moment — completed_at, or ended_at — is the DATABASE's now(),
--     never a value from the client: one clock for every timestamp.
--   - Completing happens on the session's own day: local_date must still be
--     a possible "today" (UTC's date, the day before or the day after — the
--     same test as starting, isPossibleToday). Otherwise a session started on
--     a missed Monday and finished on Thursday would turn Monday into "done"
--     — a late make-up nobody allowed. Stopping has no such limit: it
--     changes nothing the schedule counts.
--
-- now() is the transaction's start; the service writes its moments with the
-- same now() in the same transaction, so "equal to now()" is exact.

CREATE FUNCTION guard_session_update() RETURNS trigger
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
$$;--> statement-breakpoint

CREATE TRIGGER session_update_guard
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_update();--> statement-breakpoint

-- === 2. A checklist row: written only while its session is open ==============
--
-- The patient ticks exercises, times and rates them DURING the session; once
-- it is finished, the checklist is as final as the session (rule 1). INSERT
-- too: the checklist is written when the session starts (a skip has none),
-- and the insert policy alone (0004) would let the patient add rows to any
-- of their sessions at any time.
--
-- FOR SHARE, not a plain read — it closes a race. A tick sent while the
-- session is being completed: completing UPDATEs the session row, which
-- locks it; FOR SHARE conflicts with that lock, so this read WAITS for the
-- completion to commit, then reads the row again — completed — and refuses.
-- A plain read would see the session still open (its snapshot) and let the
-- tick land after the completion, changing a finished record. (FOR KEY
-- SHARE, which the foreign key takes, would not wait: a status change isn't
-- a key change.) FOR SHARE needs the UPDATE privilege and passes through the
-- UPDATE policy, which the session's patient — the only writer — has.

CREATE FUNCTION guard_session_exercise_open() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  session_status session_status;
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  -- The session the row belongs to: for an UPDATE, the one it ALREADY
  -- belongs to (OLD) — moving a row to another session is a change of what
  -- the row is, refused by the prescription guard (0033) with its own name;
  -- reading NEW's here would answer "finished" for a session that may not
  -- even exist.
  SELECT s.status INTO session_status
    FROM sessions s
    WHERE s.id = CASE TG_OP WHEN 'INSERT' THEN NEW.session_id ELSE OLD.session_id END
    FOR SHARE;
  IF session_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Session % is finished, so its exercises can no longer change',
      CASE TG_OP WHEN 'INSERT' THEN NEW.session_id ELSE OLD.session_id END
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_exercise_session_finished',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER session_exercise_open_guard
  BEFORE INSERT OR UPDATE ON session_exercises
  FOR EACH ROW EXECUTE FUNCTION guard_session_exercise_open();