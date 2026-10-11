-- Custom SQL migration (step 2b-iii follow-up, decided 2026-10-11): a CLOSED
-- program — completed, cancelled or archived — is read-only IN THE DATABASE,
-- not only in the service (AssignedProgramsService / SessionsService call
-- assertProgramOpen, program-state.ts). Two gaps this closes:
--   - a direct query under the app's role (or a future route that forgets the
--     service check) could still change a closed program's prescription,
--     workouts or schedule, or add a session to it;
--   - a RACE: a session started at the very moment its program is cancelled
--     passed the service's check (made before its own transaction) and was
--     inserted after the cancel — see "Why AFTER" below.
--
-- Decided with the person:
--   1. A session already in progress may still be FINISHED (status, times,
--      feedback, its exercises ticked): the work really happened. So sessions
--      are guarded on INSERT and DELETE only, session_exercises not at all
--      (their rows are created with the session).
--   2. Only the APP is guarded. The tables' OWNER — migrations, the dev seed's
--      reset, the e2e tests' set-up — is not: the seed is for development and
--      review, never real data. "The owner" is read from the catalog
--      (pg_class.relowner), so no role name is written here (the app role's
--      name is an environment variable). A superuser counts as every role.
--   3. A TRIGGER (one function for the program's child tables, one for the
--      program row), not a condition added to a dozen write policies: one
--      place for the rule, and one error the API can recognise.
--
-- Which tables: the program's exercises, workouts and schedule versions, and
-- sessions. NOT a schedule version's days and rotation: their policies
-- (0029) let them be written only in the transaction that creates their
-- version, never changed or deleted — so the only way to write one already
-- goes through a program_schedules INSERT, which this guard refuses first. A
-- trigger there could never fire for the app; a rule no test can reach is
-- left out rather than kept as dead weight.
--
-- The error: SQLSTATE 23514 (check_violation) with CONSTRAINT
-- 'assigned_program_closed' — the shape node-postgres reports for a CHECK, so
-- the existing isPgError() helper recognises it, and HttpExceptionFilter turns
-- it into the same 409 the service gives.

-- === 1. The children of a program ============================================
--
-- Why AFTER, not BEFORE: Postgres fires a row's AFTER triggers in NAME order,
-- and the foreign-key checks are AFTER triggers named "RI_ConstraintTrigger_…"
-- — upper case, so they sort before this lower-case name. An INSERT's
-- foreign-key check locks the program row (FOR KEY SHARE), and WAITS if a
-- close() holds it (SELECT … FOR UPDATE, AssignedProgramsService.close). So by
-- the time this trigger runs, a concurrent close has committed — and its query
-- (a new statement inside a plpgsql function, under READ COMMITTED: a fresh
-- snapshot) sees the program closed. A BEFORE trigger would run before the
-- wait, see the program still active, and let the row in.
--
-- The program's state is read under the caller's row-level security: a
-- program they can't see reads as nothing (closed IS NULL), and their own
-- policies refuse them anyway.

CREATE FUNCTION guard_closed_program_child() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  program_ids integer[];
  closed_id integer;
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NULL;
  END IF;
  -- The program(s) the row belongs to: before and after an UPDATE (the
  -- composite keys keep them equal today, but the rule doesn't rely on it).
  IF TG_OP = 'INSERT' THEN
    program_ids := ARRAY[NEW.assigned_program_id];
  ELSIF TG_OP = 'DELETE' THEN
    program_ids := ARRAY[OLD.assigned_program_id];
  ELSE
    program_ids := ARRAY[OLD.assigned_program_id, NEW.assigned_program_id];
  END IF;
  SELECT ap.id INTO closed_id
    FROM assigned_programs ap
    WHERE ap.id = ANY (program_ids)
      AND (ap.status <> 'active' OR ap.is_archived)
    LIMIT 1;
  IF closed_id IS NOT NULL THEN
    RAISE EXCEPTION 'Assigned program % is closed, so it can no longer change', closed_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_closed',
            TABLE = TG_TABLE_NAME;
  END IF;
  -- An AFTER trigger's result is ignored.
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE TRIGGER closed_program_guard
  AFTER INSERT OR UPDATE OR DELETE ON assigned_program_exercises
  FOR EACH ROW EXECUTE FUNCTION guard_closed_program_child();--> statement-breakpoint
CREATE TRIGGER closed_program_guard
  AFTER INSERT OR UPDATE OR DELETE ON program_workouts
  FOR EACH ROW EXECUTE FUNCTION guard_closed_program_child();--> statement-breakpoint
CREATE TRIGGER closed_program_guard
  AFTER INSERT OR UPDATE OR DELETE ON program_schedules
  FOR EACH ROW EXECUTE FUNCTION guard_closed_program_child();--> statement-breakpoint
-- Sessions: INSERT only — a session in progress may be finished (decision
-- 1), and sessions have no DELETE policy at all.
CREATE TRIGGER closed_program_guard
  AFTER INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_closed_program_child();--> statement-breakpoint

-- === 2. The program row itself ===============================================
--
-- A closed program's own row is final too: no new title, dates or swap
-- setting, and no way back to 'active' (cancelled and completed are FINAL).
-- One change remains allowed: ARCHIVING a completed (or cancelled) program —
-- `is_archived` false → true and nothing else (AssignedProgramsService.archive
-- allows it for a program with no session; the "no session" part stays the
-- service's rule). An archived program changes no more.
--
-- BEFORE UPDATE: the row is already locked when it fires, and OLD is its
-- latest committed version (an UPDATE that waited for a concurrent one
-- re-reads the row first) — so no ordering subtlety here.
-- to_jsonb(row) - 'is_archived': the whole row as JSON without that one
-- field — "everything else is unchanged" in one comparison, which stays
-- correct when columns are added later.

CREATE FUNCTION guard_closed_program_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF OLD.is_archived
     OR (
       OLD.status <> 'active'
       AND NOT (
         NEW.is_archived
         AND (to_jsonb(NEW) - 'is_archived') = (to_jsonb(OLD) - 'is_archived')
       )
     ) THEN
    RAISE EXCEPTION 'Assigned program % is closed, so it can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_closed',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER closed_program_guard
  BEFORE UPDATE ON assigned_programs
  FOR EACH ROW EXECUTE FUNCTION guard_closed_program_update();