-- Custom SQL migration (two deferred improvements, decided with the person
-- 2026-10-29): the database's own half of two rules that, until now, only the
-- services kept. Same shape as the closed-program guard (0031) and the retired
-- exercise guard (0033): a BEFORE UPDATE trigger per table, the tables' OWNER
-- exempt (migrations, the dev seed, the e2e tests' set-up, and the merge's
-- SECURITY DEFINER function — 0072 — which runs as the owner), and a refusal
-- with SQLSTATE 23514 (check_violation) and a CONSTRAINT name the API can
-- recognise (src/database/pg-errors.ts → HttpExceptionFilter).
--
-- Why a trigger and not column privileges (GRANT UPDATE (ends_at, ended_by)),
-- the other option the deferred entry named:
--   - a GRANT names the app role, whose name is an environment variable — it
--     would live in scripts/create-app-role.ts, away from every other rule of
--     these tables, and only exist where someone re-ran that script;
--   - a GRANT can only say WHICH COLUMNS may change, never HOW (a link already
--     ended, an end moved to another moment) — the person chose the stricter
--     rule below, which needs OLD and NEW side by side: a trigger;
--   - a missing privilege answers 42501, the same SQLSTATE as a row-security
--     refusal: the API couldn't tell "not yours" from "not changeable".

-- === 1. A care-team link can only be ENDED, now, while it is current ==========
--
-- Every UPDATE the app makes on care_team_members is the same one: an active
-- link gets ends_at = now() and ended_by = the person ending it
-- (CareTeamService.endMembership, endLinksWithoutSharedClinic,
-- endLinksOfDeactivatedPractitioner). The UPDATE policy (0019) already says
-- WHO may do it (an admin, or the practitioner on the link) and forces
-- ended_by to be that person — but not WHAT may change. A direct query under
-- the app's role could still:
--   - move a link to another patient or practitioner, or change when it
--     started, who created it, or why — rewriting "who treated this patient,
--     and when";
--   - RE-OPEN an ended link (ends_at → NULL): clinical access back, with no
--     CARE_TEAM_JOINED entry in the audit log;
--   - backdate an end ("I stopped treating them last week"), or push a
--     planned cover's end further out (more access than was agreed).
-- Decided with the person: the database allows exactly what the API does.
--   a. Only ends_at and ended_by may differ between OLD and NEW.
--      to_jsonb(row) - 'ends_at' - 'ended_by' is the whole row as JSON without
--      those two keys: "everything else is unchanged" in one comparison, which
--      stays right when a column is added later (the 0031 idiom).
--   b. The link must be current: not ended yet (ends_at NULL, or a planned end
--      still in the future). An ended link is final. ("Started" needs no test
--      of its own: a link that hasn't started can't be given ends_at = now()
--      anyway — care_team_members_ends_after_start refuses an end before the
--      start. A rule no test could reach is left out.)
--   c. The new end is exactly now() — the transaction's start, the same value
--      the app's `ends_at = now()` writes. IS DISTINCT FROM, so NULL (re-
--      opening, or never ending) is refused too.
-- A future feature that really needs another change (moving a planned cover's
-- end date, say) is a deliberate migration of this function, not a query.
--
-- Concurrency: two requests ending the same link at once — the second UPDATE
-- waits for the first, then re-checks its WHERE (activePeriod()) on the row
-- as committed: no longer current, so it updates nothing and the service
-- answers its own 404. This trigger never sees it.

CREATE FUNCTION guard_care_team_member_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'ends_at' - 'ended_by')
       <> (to_jsonb(OLD) - 'ends_at' - 'ended_by')
     OR (OLD.ends_at IS NOT NULL AND OLD.ends_at <= now())
     OR NEW.ends_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Care-team link % can only be ended, now, while it is current', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'care_team_member_end_only',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER care_team_member_end_only_guard
  BEFORE UPDATE ON care_team_members
  FOR EACH ROW EXECUTE FUNCTION guard_care_team_member_update();--> statement-breakpoint

-- === 2. An open program's end date never moves into the past ==================
--
-- The database's half of assertEndDateMovable (src/assigned-programs/
-- end-date.ts): moving an ACTIVE program's end date to a day before yesterday
-- in UTC is refused. Days before that have been judged — done, made up,
-- missed — and an end among them would make them vanish from the summary.
-- "Yesterday in UTC" is the earliest "today" anyone can have, the same limit
-- as the schedule versions' policies (0025).
--
-- Allowed, as in the service:
--   - the end date not changing (IS DISTINCT FROM — re-sending a stored end
--     date that is already in the past changes nothing);
--   - NULL, open-ended from now on (NULL < x is NULL, never true);
--   - any day from yesterday in UTC on — later extends, earlier shortens.
--
-- Only while the program STAYS ACTIVE (decided with the person): closing it
-- (active → completed / cancelled) sets the end date by its OWN rule,
-- closingEndDate (program-state.ts) — the practitioner's yesterday, which can
-- be two days before UTC's today — and once closed, the closed-program guard
-- (0031) makes the row final. Testing OLD.status as well keeps this trigger
-- out of a closed program's way: there, the answer is "closed", 0031's —
-- even for a statement that re-opens the program (NEW.status 'active') and
-- backdates its end, where this trigger, firing first (triggers run in name
-- order), would otherwise answer "in the past".
--
-- BEFORE UPDATE fires before the CHECKs, so an end both in the past and before
-- the start is answered here; the service checks the order first, so through
-- the API the order's own message comes first, as before.
--
-- The two clocks: the service judges with the request's clock, this trigger
-- with the transaction's start (now()). They can disagree only within a
-- moment of midnight UTC; HttpExceptionFilter answers this refusal with the
-- service's own 400 and words, so the client sees the same answer either way.

CREATE FUNCTION guard_program_end_date_move() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active'
     AND NEW.status = 'active'
     AND NEW.end_date IS DISTINCT FROM OLD.end_date
     AND NEW.end_date < (now() AT TIME ZONE 'UTC')::date - 1 THEN
    RAISE EXCEPTION 'The end date of assigned program % can''t move into the past', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_end_date_not_past',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER assigned_program_end_date_guard
  BEFORE UPDATE ON assigned_programs
  FOR EACH ROW EXECUTE FUNCTION guard_program_end_date_move();