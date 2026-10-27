-- A deactivated patient's conversations are read-only (decided 2026-10-27,
-- design decisions §22).
--
-- Until now "may these two write to each other?" meant one thing: a
-- current care-team link between them (rls_care_team_member, 0019). A
-- deactivated patient KEEPS their care team (decisions §18 — the team must
-- still read the file), so the link alone would let the team keep writing
-- to someone who can't sign in to read it. The answer becomes: a current
-- link AND the patient's account active.
--
-- One definition, as before: rls_can_message() below, used by
--   - messages_insert   (0048) — sending a message;
--   - conversations_insert (0019) — starting a conversation;
--   - the conversation list's `canSend` (MessagingService's canSendColumn).
-- So the list can never say "you can write" while the write is refused, and
-- the rule is checked at the moment of writing: an account deactivated
-- between the screen loading and the INSERT is caught here, atomically.
--
-- It reads users.is_active under the caller's own row security —
-- users_select (0007) is USING (true), so no SECURITY DEFINER is needed. It
-- is evaluated only AFTER the care-team test (AND short-circuits in
-- practice, but correctness doesn't depend on it: both must be true).
--
-- Only the PATIENT's account is read: a deactivated practitioner's links
-- are ended when they are deactivated (practitioner deactivation, Phase 6),
-- so rls_care_team_member is already false for them.
CREATE FUNCTION rls_can_message(p_practitioner_id integer, p_patient_id integer)
  RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT rls_care_team_member(p_practitioner_id, p_patient_id)
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = p_patient_id
          AND u.is_active
      );
  $$;--> statement-breakpoint

-- 0048's policy, with rls_can_message in place of rls_care_team_member —
-- nothing else changes.
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
        AND rls_can_message(c.practitioner_id, c.patient_id)
    )
  );--> statement-breakpoint

-- 0019's policy, the same substitution.
DROP POLICY conversations_insert ON conversations;--> statement-breakpoint
CREATE POLICY conversations_insert ON conversations
  FOR INSERT
  WITH CHECK (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id()
      AND rls_can_message(practitioner_id, patient_id))
    OR
    (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id()
      AND rls_can_message(practitioner_id, patient_id))
  );