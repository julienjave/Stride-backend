-- Custom SQL migration file, put your code below! --
--
-- Row-level security for invitations (table created by 0020; design
-- decisions §3, "Accounts are created by invitation only").
--
-- Who may touch an invitation is the same set of people who may manage the
-- invited ACCOUNT:
--   - an admin (every account, staff included);
--   - for a patient, a practitioner on their CARE TEAM — through
--     rls_practitioner_manages_patient(), the same function every clinical
--     policy uses since 0019. The practitioner who creates a patient joins
--     their care team in the same transaction (UsersService.create), so the
--     inviter is covered by this branch; a practitioner who has since left
--     the team has no reason to manage the patient's account anymore.
--   - the person HOLDING THE TOKEN, for one invitation only (below).
--
-- THE TOKEN BRANCH. The accept page is used before its visitor has any
-- account to log in with, so its requests carry no session — no
-- app.current_user_id, no app.current_role. users can be read without a
-- session (0007: login needs it), but an open SELECT here would let any
-- context-less query read every invitation. Instead, the app proves it holds
-- a token by putting the token's HASH in its own transaction-local setting,
-- app.invitation_token_hash (see withInvitationTokenContext in
-- rls-context.ts), and the policies let that transaction see exactly the
-- one row with that hash. Knowing the hash requires knowing the token: 256
-- random bits, emailed to one person. Same mechanism as the user context,
-- one more setting — no SECURITY DEFINER function bypassing RLS.
--
-- === 1. rls_current_user_id(): '' means "no user", not an error ===========
--
-- Found while testing this migration (2026-10-07). On a pooled connection
-- that a signed-in request used before, app.current_user_id is '' rather
-- than NULL (0007 explains why), and the original function (0003) casts it
-- straight to integer: ''::integer raises 22P02, "invalid input syntax".
-- Every policy so far happened to reach it only behind a role check
-- ("app.current_role = 'practitioner' AND …"), which '' never passes, so it
-- never fired. invitations_insert below is the first policy that calls it
-- FIRST — a context-less INSERT (a token holder trying to create an
-- invitation) then failed with 22P02 instead of being refused by the
-- policy: still refused, but as a 500, and by accident.
--
-- NULLIF turns '' into NULL, the value the function returns when the
-- setting was never set: "no user". Comparisons with NULL are never true,
-- so a branch that needs a user simply doesn't match — the refusal is the
-- policy's, every time. Same name and signature, so CREATE OR REPLACE swaps
-- the body under every policy already using it; the only behaviour change
-- is an error becoming a NULL.
CREATE OR REPLACE FUNCTION rls_current_user_id() RETURNS integer
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::integer;
  $$;--> statement-breakpoint

-- === 2. The invitations policies ==========================================

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: an admin, the patient's care team, or the token holder (the accept
-- page's lookup, and the accept itself). The patient never needs to read
-- their own invitation once signed in — after accepting, there is nothing
-- left to act on.
CREATE POLICY invitations_select ON invitations
  FOR SELECT
  USING (
    rls_is_admin()
    OR rls_practitioner_manages_patient(user_id)
    OR token_hash = current_setting('app.invitation_token_hash', true)
  );--> statement-breakpoint

-- Insert (inviting, or resending — which inserts a fresh row): always
-- recorded as invited by the person inserting (no forged "invited by"), and
-- only by an admin or a practitioner on the patient's care team. NOT the
-- token holder: a token can accept an invitation, never create one.
CREATE POLICY invitations_insert ON invitations
  FOR INSERT
  WITH CHECK (
    invited_by = rls_current_user_id()
    AND (
      rls_is_admin()
      OR rls_practitioner_manages_patient(user_id)
    )
  );--> statement-breakpoint

-- Update = closing an invitation: revoking it (admin or care team — also
-- what "resend" does to the old row), or accepting it (the token holder).
-- A revocation is always recorded as made by the person doing it — the
-- same rule as care_team_members.ended_by. The CHECK constraint
-- invitations_revoked_with_actor (0020) already guarantees revoked_by is
-- SET whenever revoked_at is; this guarantees it's set to the TRUTH.
CREATE POLICY invitations_update ON invitations
  FOR UPDATE
  USING (
    rls_is_admin()
    OR rls_practitioner_manages_patient(user_id)
    OR token_hash = current_setting('app.invitation_token_hash', true)
  )
  WITH CHECK (
    (revoked_at IS NULL OR revoked_by = rls_current_user_id())
    AND (
      rls_is_admin()
      OR rls_practitioner_manages_patient(user_id)
      OR token_hash = current_setting('app.invitation_token_hash', true)
    )
  );--> statement-breakpoint

-- Delete: deliberately NO policy, so every DELETE matches 0 rows. An
-- invitation is closed (accepted or revoked), never erased: "who invited
-- this person, and when" is kept. (Deleting the ACCOUNT would cascade, but
-- users have no DELETE policy either.)