-- Custom SQL migration (Phase 5 — Messaging, decided with the person
-- 2026-10-19/20): the database's half of the messaging rules. The service
-- follows each of them too (message-rules.ts, messaging.service.ts); these
-- make them hold for ANY query under the app's role — the "every rule exists
-- twice" approach of 0031, 0033, 0038 and 0041.
--
--   1. READING: only the two participants. Admins no longer read
--      conversations or messages (the person's choice: messages are clinical
--      content, admins aren't on care teams — HIPAA's "minimum necessary";
--      oversight comes from the audit trail).
--   2. WRITING A MESSAGE: a participant, as themselves, AND only while the
--      two are on a care team together. A conversation whose practitioner
--      left the team stays readable by both, but read-only (the person's
--      choice) — before, the care team was checked only when STARTING a
--      conversation, so a former member could keep writing forever.
--   3. A MESSAGE'S CHANGES, as triggers (rules about OLD vs NEW, which
--      neither a CHECK nor a policy can express): what was said never
--      changes; "read" is set once, by the recipient; "deleted" is set once,
--      by the sender, while unread and within 15 minutes. Every moment is
--      the database's now().
--   4. A CONVERSATION'S PARTICIPANTS never change (a participant could
--      re-point a conversation at someone else before: the UPDATE policy
--      only checked that THEY stayed in it).
--
-- Only the APP is guarded. The tables' OWNER (migrations, the dev seed —
-- which writes past messages with past moments — and the e2e tests'
-- set-up) is exempt, found from the catalog with no role name written here
-- (0031 explains why). A refusal is SQLSTATE 23514 (check_violation) with a
-- CONSTRAINT name, the shape isCheckViolation() (pg-errors.ts) recognises;
-- HttpExceptionFilter (and the WebSocket filter, which reuses its
-- translation) turns each into the service's own answer.

-- === 1. Reading: the participants only =======================================

-- The same policy as 0005's without its first branch, rls_is_admin().
DROP POLICY conversations_select ON conversations;--> statement-breakpoint
CREATE POLICY conversations_select ON conversations
  FOR SELECT
  USING (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id())
    OR (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id())
  );--> statement-breakpoint

-- messages_select (0005) is NOT re-created: it already says "you see a
-- message when you see its conversation" (an EXISTS on conversations, which
-- row security filters for the caller). Taking admins out of
-- conversations_select takes them out of messages too — one rule, in one
-- place. test/messaging.e2e-spec.ts checks it as the app's own role.

-- === 2. Writing a message: participants on a care team together ==============

-- 0005's policy plus rls_care_team_member() — the SAME function that
-- conversations_insert (0019) uses to let a conversation start, and that
-- the conversation list selects as `canSend` (MessagingService), so "may I
-- write here?" has one definition in three places. It reads
-- care_team_members under the caller's own row security: a patient sees
-- their own team, a practitioner their own links — exactly the pair needed.
--
-- This is also what makes the rule race-free: the service checks the care
-- team first (for a clear 403), but a care-team link ended between that
-- check and the INSERT is caught HERE, at the moment of writing (each
-- statement takes a new snapshot under READ COMMITTED). The service turns
-- that refusal (42501) into the same 403.
DROP POLICY messages_insert ON messages;--> statement-breakpoint
CREATE POLICY messages_insert ON messages
  FOR INSERT
  WITH CHECK (
    sender_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (
          (current_setting('app.current_role', true) = 'practitioner'
            AND c.practitioner_id = rls_current_user_id())
          OR (current_setting('app.current_role', true) = 'patient'
            AND c.patient_id = rls_current_user_id())
        )
        AND rls_care_team_member(c.practitioner_id, c.patient_id)
    )
  );--> statement-breakpoint

-- messages_update (0005) stays as it is: a participant may update a row of
-- their conversation — and the trigger below decides WHICH changes, and by
-- whom. (A policy sees only the new row; "only the sender deletes, only the
-- recipient reads" compares the caller with the row's sender and the old
-- row with the new.)

-- === 3. A message: fixed content, read once, deleted once =====================

-- On INSERT: the moment is the database's, and a message starts unread and
-- not deleted. sent_at's DEFAULT now() is only a default — a client could
-- send any moment; the trigger overwrites it, like session_reviews (0044).
CREATE FUNCTION guard_message_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF NEW.read_at IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A new message starts unread and not deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'message_starts_unread',
            TABLE = TG_TABLE_NAME;
  END IF;
  NEW.sent_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER message_insert_guard
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_insert();--> statement-breakpoint

-- On UPDATE, the only two changes a message ever has:
--   - read_at, from NULL to now(), by the RECIPIENT (not the sender — your
--     own message isn't "read"), and only while it isn't deleted;
--   - deleted_at, from NULL to now(), by the SENDER, while it is still
--     unread and at most 15 minutes old.
-- Anything else — the text, the sender, the conversation, the moment it was
-- sent, un-reading, un-deleting, re-stamping — is refused.
--
-- The delete-vs-read race: the recipient's "mark as read" and the sender's
-- "delete" both UPDATE the same row, and a row update takes the row's lock.
-- The second one WAITS for the first to commit; then Postgres re-reads the
-- row (the latest version) before running this BEFORE trigger on it. So a
-- delete arriving just after the read sees read_at set, and is refused;
-- a read arriving just after the delete is skipped by markAsRead's own
-- WHERE (deleted_at IS NULL). test/messaging.e2e-spec.ts holds the first
-- write open and checks the second one waits, then gets the right answer.
--
-- The 15 minutes are written here as an interval; message-rules.ts holds
-- the same value (DELETE_WINDOW_MS) for the service's own check and its
-- message — the e2e suite tests both edges against this trigger.
CREATE FUNCTION guard_message_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  actor integer := rls_current_user_id();
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  IF (NEW.conversation_id, NEW.sender_id, NEW.message_body, NEW.sent_at)
     IS DISTINCT FROM
     (OLD.conversation_id, OLD.sender_id, OLD.message_body, OLD.sent_at) THEN
    RAISE EXCEPTION 'Message % can no longer change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'message_content_fixed',
            TABLE = TG_TABLE_NAME;
  END IF;
  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    IF OLD.read_at IS NOT NULL
       OR OLD.deleted_at IS NOT NULL
       OR NEW.read_at IS DISTINCT FROM now()
       OR actor = OLD.sender_id THEN
      RAISE EXCEPTION 'Message % can only be marked read once, by its recipient', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'message_read_by_recipient',
              TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF OLD.deleted_at IS NOT NULL
       OR NEW.deleted_at IS DISTINCT FROM now()
       OR actor IS DISTINCT FROM OLD.sender_id
       OR OLD.read_at IS NOT NULL
       OR now() - OLD.sent_at > interval '15 minutes' THEN
      RAISE EXCEPTION 'Message % can no longer be deleted', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'message_delete_window',
              TABLE = TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER message_update_guard
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_update();--> statement-breakpoint

-- === 4. A conversation: its participants and start never change ==============
--
-- The UPDATE policy (0005) lets a participant update their conversation —
-- for archiving — and its WITH CHECK only requires that THEY are still in it
-- afterwards: a patient could have re-pointed practitioner_id at another
-- practitioner, moving the whole history to someone else. Archiving is the
-- only update the app makes; everything that says who the conversation is
-- between, and when it started, is fixed.
CREATE FUNCTION guard_conversation_update() RETURNS trigger
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
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER conversation_update_guard
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION guard_conversation_update();