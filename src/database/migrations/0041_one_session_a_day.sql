-- Custom SQL migration (late make-ups, decided with the person 2026-10-16):
-- ONE SESSION A DAY, the database's half. A program's day that already has a
-- COMPLETED session takes no other session — not the same workout again, not
-- a swap half, not a make-up, not a skip. The service checks it first, with a
-- clear message (SessionsService.create); this makes it hold for ANY query
-- under the app's role, and closes the race the service's read can't:
--
--   the patient finishes session A          the patient starts session B
--   (same program, same day)                (another tab, the same moment)
--   ─────────────────────────               ─────────────────────────────
--   locks A, sets it completed …            reads "a completed session
--                                            today?" → none yet (A is still
--                                            in progress in its snapshot)
--   … commits                               inserts B → would succeed: A is
--                                            no longer open, so the
--                                            one-open-session index is happy
--
-- Built like 0038's guards: a BEFORE trigger (it must look at OTHER rows,
-- which no CHECK can); the tables' OWNER (migrations, the dev seed, the e2e
-- set-up) exempt, found from the catalog; the refusal a 23514 with a
-- CONSTRAINT name, which HttpExceptionFilter turns into the service's 409.
--
-- FOR SHARE is what closes the race. The finishing request holds A's row
-- locked (SessionsService.complete locks it; any UPDATE would). FOR SHARE
-- conflicts with that lock, so this read WAITS for A's transaction to end,
-- then reads A again — completed — and refuses. A plain read would see A as
-- still in progress and let B in. (FOR SHARE needs the UPDATE privilege and
-- passes through the UPDATE policy: sessions are inserted only by their
-- patient — sessions_insert — whose sessions_update policy covers all of
-- their sessions, whatever their status.) The other order is safe too: if B
-- locks A first, A is still open and B's insert fails on the one-open-session
-- index — refused either way.

CREATE FUNCTION guard_session_one_a_day() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  other_status session_status;
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  -- Every session of the program that day, locked; any completed one
  -- refuses the new row. (A loop rather than EXISTS: the lock must be taken
  -- on the rows themselves, and a status checked AFTER the wait — the row
  -- as it is once the other transaction has committed.)
  FOR other_status IN
    SELECT s.status
      FROM sessions s
      WHERE s.assigned_program_id = NEW.assigned_program_id
        AND s.local_date = NEW.local_date
      FOR SHARE
  LOOP
    IF other_status = 'completed' THEN
      RAISE EXCEPTION 'Program % already has a completed session on %',
        NEW.assigned_program_id, NEW.local_date
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'session_one_completed_per_day',
              TABLE = TG_TABLE_NAME;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER session_one_a_day_guard
  BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_one_a_day();