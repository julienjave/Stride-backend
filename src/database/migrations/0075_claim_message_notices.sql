-- Custom SQL migration (roadmap Phase 6.5, "new-message emails"). Two parts:
--   1. guard_conversation_update() extended: the app's role may CLEAR a
--      side's "notified" marker (0074's practitioner_notified_at /
--      patient_notified_at — reading the thread does), never SET or move it;
--   2. claim_message_notices() — the project's SECOND SECURITY DEFINER
--      function: the minute-by-minute sweep's one door to "who has unread
--      messages waiting".
--
-- WHY A DEFINER FUNCTION: the sweep runs with NO signed-in user. Every
-- policy on conversations, messages and users starts from "who is asking"
-- (app.current_user_id) — with nobody asking, they show nothing, as they
-- should. The alternatives were worse:
--   - a "system" branch in three tables' policies, opened by a setting the
--     app's role could set in ANY transaction — a door every request could
--     walk through;
--   - a separate database role for the job, with its own credentials and
--     grants — a second identity to deploy and rotate for one query.
-- A definer function is ONE door that does ONE thing: find the due
-- notices, mark them claimed, and return only what an email needs — the
-- recipient's address and first name, the other participant's name, the
-- side (for the link). NEVER a message's text: it isn't selected at all.
-- The same hardening as merge_patients() (0072), explained there line by
-- line: SECURITY DEFINER, SET search_path = public, pg_temp, SET
-- row_security = off (fail loudly rather than return a filtered nothing),
-- EXECUTE revoked from PUBLIC and granted to the app's role only.
--
-- One check of its own: it refuses to run INSIDE a request's context (a
-- transaction where app.current_user_id is set — withRlsContext sets it for
-- every request). The sweep calls it on a plain connection; a request never
-- has a reason to — so even a bug (or an injection) inside a request can't
-- use it.

-- === 1. A conversation's "notified" markers: cleared by the app, set only here ===
--
-- The UPDATE policy (0005) lets either participant update their
-- conversation (for archiving), with no column limits — so without this, a
-- patient's direct query could set the PRACTITIONER's marker and silence
-- their notices, or clear one to have them emailed again. The rule: for the
-- app's role a marker may stay as it is, or become NULL — nothing else.
-- (Which side clears which is the service's business: reading clears the
-- reader's own; clearing the other side's would only cause one extra,
-- harmless email.) The owner — the claim function's identity — is exempt,
-- like every guard.
CREATE OR REPLACE FUNCTION guard_conversation_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF (NEW.practitioner_id, NEW.patient_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.practitioner_id, OLD.patient_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Who conversation % is between can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'conversation_participants_fixed',
            TABLE = TG_TABLE_NAME;
  END IF;
  IF (NEW.practitioner_notified_at IS NOT NULL
        AND NEW.practitioner_notified_at IS DISTINCT FROM OLD.practitioner_notified_at)
     OR (NEW.patient_notified_at IS NOT NULL
        AND NEW.patient_notified_at IS DISTINCT FROM OLD.patient_notified_at) THEN
    RAISE EXCEPTION 'Only the notice sweep may mark conversation % as notified', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'conversation_notified_by_sweep_only',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- === 2. claim_message_notices(min_age_minutes) ==================================
--
-- Due = a side of a conversation (practitioner or patient) that
--   - has NOT been emailed since it last read (its marker is NULL);
--   - has at least one message FROM THE OTHER SIDE, unread, not deleted,
--     sent at least `min_age_minutes` ago (the app passes 15: the sender's
--     delete window — a message deleted in its window never sends an email);
--   - is an ACTIVE account with message_email_notices on.
-- A side that isn't due because of the last two points is NOT marked: if the
-- person turns notices back on (or is reactivated), the next sweep tells
-- them.
--
-- CLAIMING, so two sweeps never send the same email (two backend instances,
-- or a slow sweep overlapping the next): the conversations are locked
-- `FOR UPDATE SKIP LOCKED` — a row another transaction has locked is
-- SKIPPED, not waited for — and the markers are set in the SAME statement
-- that returns the rows. The second sweep either sees the markers set, or
-- skips the rows still locked by the first. (A conversation skipped
-- because a participant is archiving it at that instant is simply picked up
-- by the next sweep, a minute later.)
--
-- AT MOST ONCE: the marker is set BEFORE the email is sent (the app sends
-- after this transaction commits — a network call doesn't belong inside it).
-- If sending then fails, that notice is lost; the app logs it. Retrying
-- would mean keeping "claimed but not sent" as a third state, and a missed
-- notice costs little: the message is still there, the badge still shows it.
CREATE FUNCTION claim_message_notices(min_age_minutes integer)
  RETURNS TABLE (
    conversation_id integer,
    recipient_id integer,
    recipient_side text,
    recipient_email varchar,
    recipient_first_name varchar,
    sender_first_name varchar,
    sender_last_name varchar
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
AS $$
DECLARE
  cutoff timestamptz;
BEGIN
  IF coalesce(current_setting('app.current_user_id', true), '') <> '' THEN
    RAISE EXCEPTION 'claim_message_notices() is for the notice sweep, not a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF min_age_minutes IS NULL OR min_age_minutes < 1 THEN
    RAISE EXCEPTION 'min_age_minutes must be at least 1'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  cutoff := now() - make_interval(mins => min_age_minutes);

  RETURN QUERY
  WITH locked AS (
    -- The conversations with something possibly due, locked (SKIP LOCKED:
    -- see above). The two flags say, per side, whether the OTHER side wrote
    -- something that has waited long enough and the side isn't notified.
    SELECT c.id, c.practitioner_id, c.patient_id,
           c.practitioner_notified_at IS NULL AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.sender_id = c.patient_id
               AND m.read_at IS NULL AND m.deleted_at IS NULL
               AND m.sent_at <= cutoff
           ) AS to_practitioner,
           c.patient_notified_at IS NULL AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.sender_id = c.practitioner_id
               AND m.read_at IS NULL AND m.deleted_at IS NULL
               AND m.sent_at <= cutoff
           ) AS to_patient
    FROM conversations c
    -- A FILTER, not a rule: the two flags above decide who is due. This
    -- only keeps conversations with nothing waiting long enough from being
    -- read and LOCKED at all (a participant archiving one meanwhile would
    -- otherwise be skipped for nothing); messages_unread_idx serves it.
    WHERE (c.practitioner_notified_at IS NULL OR c.patient_notified_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.read_at IS NULL AND m.deleted_at IS NULL
          AND m.sent_at <= cutoff
      )
    FOR UPDATE OF c SKIP LOCKED
  ),
  sides AS (
    SELECT l.id, 'practitioner'::text AS side, l.practitioner_id AS recipient, l.patient_id AS sender
    FROM locked l WHERE l.to_practitioner
    UNION ALL
    SELECT l.id, 'patient'::text, l.patient_id, l.practitioner_id
    FROM locked l WHERE l.to_patient
  ),
  due AS (
    SELECT s.id, s.side, s.recipient, r.email, r.first_name,
           snd.first_name AS sender_first, snd.last_name AS sender_last
    FROM sides s
    JOIN users r ON r.id = s.recipient
    JOIN users snd ON snd.id = s.sender
    WHERE r.is_active AND r.message_email_notices
  ),
  -- A data-modifying CTE runs whether or not the final SELECT reads it, and
  -- in the same statement — the claim and the answer are one atomic step.
  marked AS (
    UPDATE conversations c
    SET practitioner_notified_at = CASE
          WHEN EXISTS (SELECT 1 FROM due d WHERE d.id = c.id AND d.side = 'practitioner')
          THEN now() ELSE c.practitioner_notified_at END,
        patient_notified_at = CASE
          WHEN EXISTS (SELECT 1 FROM due d WHERE d.id = c.id AND d.side = 'patient')
          THEN now() ELSE c.patient_notified_at END
    WHERE c.id IN (SELECT d.id FROM due d)
    RETURNING c.id
  )
  SELECT d.id, d.recipient, d.side, d.email, d.first_name, d.sender_first, d.sender_last
  FROM due d
  ORDER BY d.recipient, d.id;
END
$$;--> statement-breakpoint

-- Functions are executable by PUBLIC by default — not this one.
REVOKE EXECUTE ON FUNCTION claim_message_notices(integer) FROM PUBLIC;--> statement-breakpoint

-- The app's role, when it already exists (see 0072 for why it's found this
-- way); a database set up later gets it from scripts/create-app-role.ts.
DO $$
DECLARE
  app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'users'
      AND privilege_type = 'UPDATE' AND grantee <> current_user
      AND grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION claim_message_notices(integer) TO %I', app_role);
  END LOOP;
END
$$;