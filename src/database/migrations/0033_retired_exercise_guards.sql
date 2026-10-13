-- Custom SQL migration (step 3b-0, decided 2026-10-13): the database's half of
-- two rules added by 0032. The service already follows both; these make them
-- hold for ANY query under the app's role — a future route that forgets, or a
-- direct query — the same "every rule exists twice" approach as the
-- closed-program guard (0031), and built the same way:
--   - BEFORE UPDATE triggers: they compare the row before (OLD) and after
--     (NEW) the change, which a policy can't do (a policy's WITH CHECK sees
--     only the new row).
--   - Only the APP is guarded. The tables' OWNER (migrations, the dev seed's
--     reset, the e2e tests' set-up) is exempt, found from the catalog — no
--     role name written here (0031 explains why).
--   - A refusal is SQLSTATE 23514 (check_violation) with a CONSTRAINT name,
--     the shape isCheckViolation() (pg-errors.ts) recognises.
--
-- Why BEFORE here, when 0031 chose AFTER: 0031 had to wait for a concurrent
-- close() to commit before reading the PROGRAM row (a different row). These
-- triggers only read the row being updated: by the time a BEFORE UPDATE
-- trigger fires, that row is locked and OLD is its latest committed version
-- (an UPDATE that waited for another one re-reads the row first). So two
-- requests racing — a prescription edit and a removal — are taken one after
-- the other, and the second sees what the first did.

-- === 1. A retired program exercise is final ==================================
--
-- Retiring = removing from the program an exercise that sessions used: it
-- stays only so those sessions keep pointing at it. Changing it afterwards —
-- a new prescription, a move to another workout, or "un-retiring" it — would
-- either rewrite history or bring back, silently, something the practitioner
-- removed (and the audit entry of the removal would no longer describe the
-- data). To use it again, the practitioner adds the exercise anew.
--
-- And the moment of retiring must name its author: retired_by = the user
-- doing it, as care_team_members' ended_by and invitations' revoked_by do
-- (their policies) — the audit entry says who, and so does the row.

CREATE FUNCTION guard_retired_program_exercise() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Exercise % was removed from its program, so it can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_exercise_retired',
            TABLE = TG_TABLE_NAME;
  END IF;
  -- Being retired by this UPDATE: whoever does it signs it.
  IF NEW.retired_at IS NOT NULL
     AND NEW.retired_by IS DISTINCT FROM rls_current_user_id() THEN
    RAISE EXCEPTION 'Exercise % must be retired in the name of the user retiring it', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_exercise_retired_by',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER retired_program_exercise_guard
  BEFORE UPDATE ON assigned_program_exercises
  FOR EACH ROW EXECUTE FUNCTION guard_retired_program_exercise();--> statement-breakpoint

-- === 2. A session's copy of its prescription is fixed ========================
--
-- session_exercises now holds what was prescribed when the session started
-- (name, sets, reps, duration, weight, notes — 0032). The patient updates
-- their own rows while doing the session (completed, duration, difficulty,
-- feedback: the session_exercises_update policy, 0004) — but a policy says
-- WHICH ROWS a user may update, never which COLUMNS. So the copy, and which
-- session and program exercise the row belongs to, are guarded here: what
-- was prescribed is history, like everything else about a session. (The API
-- never sends these fields — UpdateSessionExerciseDto doesn't have them, and
-- the ValidationPipe refuses unknown ones.)
--
-- One row comparison: (a, b, …) IS DISTINCT FROM (c, d, …) is true when any
-- pair differs, NULLs compared as values (NULL vs NULL = the same) — what
-- plain `<>` can't do (NULL <> 3 is NULL, not true).

CREATE FUNCTION guard_session_exercise_prescription() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF (NEW.session_id, NEW.assigned_program_exercise_id, NEW.name, NEW.sets,
      NEW.reps, NEW.duration_in_seconds, NEW.weight, NEW.weight_unit,
      NEW.notes)
     IS DISTINCT FROM
     (OLD.session_id, OLD.assigned_program_exercise_id, OLD.name, OLD.sets,
      OLD.reps, OLD.duration_in_seconds, OLD.weight, OLD.weight_unit,
      OLD.notes) THEN
    RAISE EXCEPTION 'What session exercise % prescribed can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_exercise_prescription_fixed',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER session_exercise_prescription_guard
  BEFORE UPDATE ON session_exercises
  FOR EACH ROW EXECUTE FUNCTION guard_session_exercise_prescription();