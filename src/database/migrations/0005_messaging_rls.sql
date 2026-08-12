-- Reuses rls_is_admin() and rls_current_user_id(), defined in
-- 0003_assigned_programs_rls.sql — no redefinition here.
--
-- rls_practitioner_manages_patient() doesn't fit createConversation's
-- patient-initiated branch: it assumes the CURRENT session is the
-- practitioner, but here the current session might be the patient. What's
-- needed instead is a general, role-agnostic "do these two arbitrary user
-- ids share a clinic" check, usable regardless of which one is the caller.
CREATE FUNCTION rls_clinic_overlap(user_a integer, user_b integer)
  RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1
      FROM user_clinics uc_a
      JOIN user_clinics uc_b ON uc_a.clinic_id = uc_b.clinic_id
      WHERE uc_a.user_id = user_a AND uc_b.user_id = user_b
    );
  $$;--> statement-breakpoint

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: unlike every other table in this rollout, conversations has its
-- participant ids directly on the row — a plain two-column check, no
-- clinic-membership join needed. Admin sees any row; a practitioner sees
-- conversations where they are the practitioner; a patient sees
-- conversations where they are the patient.
CREATE POLICY conversations_select ON conversations
  FOR SELECT
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND practitioner_id = rls_current_user_id())
    OR (current_setting('app.current_role', true) = 'patient'
        AND patient_id = rls_current_user_id())
  );--> statement-breakpoint

-- Create: matches MessagingService.createConversation — either side of a
-- genuine clinical relationship can start the conversation, but ONLY as
-- themselves, and only when rls_clinic_overlap() confirms the two parties
-- actually share a clinic (the app-layer isPatientManagedBy check,
-- mirrored here in SQL).
CREATE POLICY conversations_insert ON conversations
  FOR INSERT
  WITH CHECK (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id()
      AND rls_clinic_overlap(practitioner_id, patient_id))
    OR
    (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id()
      AND rls_clinic_overlap(practitioner_id, patient_id))
  );--> statement-breakpoint

-- Write (archive/unarchive): participant-only, admin deliberately excluded
-- — archiveConversation/unarchiveConversation explicitly reject admins
-- even though they pass the participant check (see the messaging
-- admin-write-bypass fix, docs/writeup/22). This mirrors that: admin IS
-- visible via conversations_select above, but has no update policy branch
-- at all here.
CREATE POLICY conversations_update ON conversations
  FOR UPDATE
  USING (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id())
    OR (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id())
  )
  WITH CHECK (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id())
    OR (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id())
  );--> statement-breakpoint

-- No DELETE policy — there is no DELETE route or service method for
-- conversations. Under FORCE ROW LEVEL SECURITY with no DELETE policy, any
-- DELETE is rejected outright, for every role including admin.

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: messages has no participant columns of its own beyond sender_id —
-- visibility is always "does the parent conversations row satisfy the
-- relevant condition," never re-derived independently, same shape as
-- assigned_program_exercises/session_exercises. This relies on
-- conversations' own FORCE ROW LEVEL SECURITY already filtering the
-- subquery to rows the caller can see — if you can see the conversation,
-- you see its messages. Since conversations_select already includes
-- admin, admin sees every message here too, matching getMessages() having
-- no admin block (unlike every write method on this table).
CREATE POLICY messages_select ON messages
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id)
  );--> statement-breakpoint

-- Write (sendMessage's INSERT, markAsRead's/deleteMessage's UPDATE): the
-- participant check runs against the PARENT conversation, admin excluded
-- — same rule as conversations_update, not conversations_select. INSERT
-- additionally requires sender_id to be the caller's own id.
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
    )
  );--> statement-breakpoint

CREATE POLICY messages_update ON messages
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (
          (current_setting('app.current_role', true) = 'practitioner'
            AND c.practitioner_id = rls_current_user_id())
          OR (current_setting('app.current_role', true) = 'patient'
            AND c.patient_id = rls_current_user_id())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (
          (current_setting('app.current_role', true) = 'practitioner'
            AND c.practitioner_id = rls_current_user_id())
          OR (current_setting('app.current_role', true) = 'patient'
            AND c.patient_id = rls_current_user_id())
        )
    )
  );--> statement-breakpoint

-- No DELETE policy — deleteMessage is a soft delete (UPDATE deleted_at);
-- the app never issues a real DELETE against this table. The 15-minute
-- window and already-read checks in deleteMessage are business rules with
-- specific, friendly error messages the app layer already produces — RLS
-- deliberately does not try to encode them here, matching how no other
-- table in this rollout encodes a time-based or finer-grained business
-- rule in a policy.
