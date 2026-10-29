-- Custom SQL migration (duplicate patients, pass 3 — decisions §27): merging
-- two accounts of the same patient. Three parts:
--   1. row-level security on the two new tables (0071);
--   2. the notice reviews' trigger (`reviewed_at` is the database's clock);
--   3. merge_patients() — the project's FIRST SECURITY DEFINER function.
--
-- WHY A DEFINER FUNCTION HERE, after avoiding them everywhere else (0011,
-- 0021, 0039 each said why they didn't need one):
--   A merge moves rows an ADMIN is deliberately forbidden to read or change —
--   programs, sessions, medical files, messages (decisions §16: admins hold no
--   clinical access, down to the policies). The earlier cases needed a narrow
--   extra right for the actor's OWN write; this one needs to rewrite about ten
--   tables' rows on behalf of someone the policies exclude. The alternative —
--   a "merge in progress" branch in ~10 policies and ~6 triggers — would
--   spread one rare operation across the whole schema. A definer function is
--   ONE door: it runs with its OWNER's rights (the role that owns the tables,
--   whom every guard trigger already exempts), takes two ids, checks who is
--   asking, and does nothing else. The person chose it (2026-10-29).
--
-- Its hardening, line by line in the function's header:
--   - SECURITY DEFINER: the body runs as the owner (current_user = owner).
--   - SET search_path = public, pg_temp: a definer function must never
--     resolve a name through a schema the CALLER controls — a caller could
--     otherwise create its own `users` (or `now()`) earlier on the path and
--     have the owner run it. pg_temp is named LAST on purpose: left out, it
--     would be searched FIRST.
--   - SET row_security = off: the owner is a superuser or has BYPASSRLS in
--     every Stride set-up, so policies don't filter it — and if one day it
--     didn't, FORCE ROW LEVEL SECURITY would silently hide every clinical row
--     from it (an admin's context reads none) and the merge would "succeed"
--     having moved nothing. With row_security = off, a role that row security
--     WOULD filter gets an ERROR instead (42501): the merge fails loudly. The
--     sweeper's rule (decisions §27).
--   - EXECUTE revoked from PUBLIC (functions are executable by everyone by
--     default), granted to the app's role only — below, and in
--     scripts/create-app-role.ts for a database set up after this migration.
--   - The caller is checked INSIDE: an admin session (the same context every
--     policy trusts), holding the admin role, active.
--
-- What it does is listed where it does it. It never writes the audit entry
-- or ends the merged account's sign-in sessions: the service does, in the
-- SAME transaction (UsersService.mergePatient) — the entry with the summary
-- this function answers.

-- === 1. Row-level security ===================================================

ALTER TABLE patient_merges ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_merges FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_merge_notice_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_merge_notice_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Staff read every merge: admins (the users list says "merged into …", a
-- merged account can't be reactivated) and practitioners (inviting a patient
-- leaves merged-away accounts out of the duplicate check — a check that
-- looks at EVERY patient with that birth date, not only the practitioner's
-- own). A merge row is two account ids, a time and an admin's id — nothing
-- that `users` (readable by everyone signed in) doesn't already show. NO
-- insert, update or delete policy: only merge_patients() — as the owner —
-- writes a merge.
CREATE POLICY patient_merges_select ON patient_merges
  FOR SELECT
  USING (
    rls_is_admin()
    OR current_setting('app.current_role', true) = 'practitioner'
  );--> statement-breakpoint

-- A practitioner reads and writes only their own reviews, of merges of their
-- own patients (the legal disclosure notices' policies, 0069).
CREATE POLICY patient_merge_notice_reviews_select ON patient_merge_notice_reviews
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'practitioner'
    AND practitioner_id = rls_current_user_id()
  );--> statement-breakpoint
CREATE POLICY patient_merge_notice_reviews_insert ON patient_merge_notice_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM patient_merges m
      WHERE m.id = patient_merge_notice_reviews.merge_id
        AND rls_practitioner_manages_patient(m.survivor_id)
    )
  );--> statement-breakpoint

-- === 2. A review is stamped by the database's clock ==========================

CREATE FUNCTION guard_patient_merge_notice_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER patient_merge_notice_review_guard
  BEFORE INSERT ON patient_merge_notice_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_patient_merge_notice_review();--> statement-breakpoint

-- === 3. merge_patients(merged, survivor) =====================================
--
-- Moves everything of `p_merged` to `p_survivor`, deactivates `p_merged`,
-- records the merge, and answers what it did (jsonb — the audit entry's
-- details). One statement per kind of row, each RETURNING the ids it touched.
-- Runs inside the caller's transaction: if anything fails, nothing moved.
CREATE FUNCTION merge_patients(p_merged integer, p_survivor integer)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
AS $$
DECLARE
  actor integer := rls_current_user_id();
  merge_id integer;
  link record;
  free_piece tstzrange;
  program_ids integer[];
  -- sessions and messages have bigint ids (bigserial).
  session_ids bigint[];
  medical_file_ids integer[];
  moved_conversation_ids integer[] := '{}';
  combined jsonb := '[]';
  message_ids bigint[];
  moved_link_ids integer[] := '{}';
  ended_link_ids integer[] := '{}';
  new_link_ids integer[] := '{}';
  new_link_id integer;
  review_ids integer[];
  ended_review_ids integer[];
  disclosure_ids integer[];
  clinic_ids integer[];
  invitation_ids integer[];
  export_link_ids integer[];
  filled text[] := '{}';
  conv record;
  target_conversation integer;
  survivor_row users%ROWTYPE;
  merged_row users%ROWTYPE;
BEGIN
  -- --- Who is asking ---------------------------------------------------------
  -- The admin context every policy trusts, AND the role really held by an
  -- active account: the context names an id; the tables say what it is.
  IF NOT rls_is_admin()
     OR actor IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin'
       WHERE u.id = actor AND u.is_active
     ) THEN
    RAISE EXCEPTION 'Only an admin can merge patient accounts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- --- What may be merged ----------------------------------------------------
  -- The service checks all of this first, with readable answers (400 / 404 /
  -- 409); these are the database's half — a direct call can't skip them.
  -- Both rows LOCKED, in id order (two merges of the same pair can't
  -- deadlock; the second waits, then sees the first's result).
  PERFORM 1 FROM users WHERE id IN (p_merged, p_survivor) ORDER BY id FOR UPDATE;
  SELECT * INTO merged_row FROM users WHERE id = p_merged;
  SELECT * INTO survivor_row FROM users WHERE id = p_survivor;
  -- (A missing account holds no role: the two role tests refuse it too.)
  IF p_merged = p_survivor
     -- The account merged away holds the patient role and NOTHING else:
     -- merging deactivates it, never a staff account. ARRAY(SELECT …) is
     -- '{}' for no role at all, never NULL — so the comparison can't be
     -- NULL and slip through the IF.
     OR ARRAY(SELECT role::text FROM user_roles WHERE user_id = p_merged)
        <> ARRAY['patient']
     OR NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_survivor AND role = 'patient')
     OR NOT survivor_row.is_active
     -- Merged away already, either of them. (A merged account is
     -- deactivated, so the survivor's half also guards a merged account
     -- someone reactivated by hand.)
     OR EXISTS (SELECT 1 FROM patient_merges WHERE merged_id IN (p_merged, p_survivor)) THEN
    RAISE EXCEPTION 'Accounts % and % cannot be merged', p_merged, p_survivor
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_merge_allowed';
  END IF;

  -- --- Programs, sessions, medical files: the record itself ------------------
  -- Programs carry their workouts, exercises, schedules and own photos (all
  -- keyed by the program); sessions carry their checklists and reviews.
  -- Medical files in ONE statement: an amendment points at its original by
  -- (id, patient_id) — a foreign key Postgres checks at the END of the
  -- statement, by which time both rows have moved together.
  WITH moved AS (
    UPDATE assigned_programs SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO program_ids FROM moved;

  WITH moved AS (
    UPDATE sessions SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO session_ids FROM moved;

  WITH moved AS (
    UPDATE medical_files SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO medical_file_ids FROM moved;

  -- --- Conversations: one thread per practitioner ---------------------------
  -- The person's choice: two threads with the same practitioner become ONE.
  -- The merged account's messages move into the survivor's thread, keeping
  -- their times and senders (sent_at orders a thread, so they interleave in
  -- date order); its now-empty thread is deleted (it was the same person's,
  -- and a practitioner would otherwise see an empty thread with a
  -- deactivated namesake). A thread with a practitioner the survivor never
  -- wrote with simply changes hands. Either way, what the merged account SENT
  -- is now sent by the survivor — it was them.
  FOR conv IN
    SELECT id, practitioner_id FROM conversations
    WHERE patient_id = p_merged ORDER BY id
  LOOP
    SELECT id INTO target_conversation FROM conversations
    WHERE patient_id = p_survivor AND practitioner_id = conv.practitioner_id;
    IF target_conversation IS NULL THEN
      UPDATE conversations SET patient_id = p_survivor WHERE id = conv.id;
      moved_conversation_ids := moved_conversation_ids || conv.id;
    ELSE
      WITH moved AS (
        UPDATE messages SET conversation_id = target_conversation
        WHERE conversation_id = conv.id RETURNING id
      ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO message_ids FROM moved;
      DELETE FROM conversations WHERE id = conv.id;
      combined := combined || jsonb_build_object(
        'from', conv.id, 'into', target_conversation, 'messageIds', to_jsonb(message_ids)
      );
    END IF;
  END LOOP;
  UPDATE messages SET sender_id = p_survivor WHERE sender_id = p_merged;

  -- --- Care-team links: never two overlapping periods ------------------------
  -- care_team_members_no_overlap forbids two links of the same patient and
  -- practitioner whose periods overlap. Per link of the merged account:
  --   - no overlap with any of the survivor's links to that practitioner:
  --     the link MOVES (same id — the join notices' reviews point at it);
  --   - an overlap: the survivor already covers part of that time. The
  --     link's period MINUS the survivor's (a multirange difference — the
  --     survivor's links, as one set of times, taken out) is what's left to
  --     cover; each remaining piece becomes a NEW link of the survivor, with
  --     the original's creator and reason. The original stays on the merged
  --     account as its history, ENDED now if it was open — a deactivated
  --     patient keeps their care team otherwise (decisions §18), and this one
  --     has nothing left to treat.
  FOR link IN
    SELECT * FROM care_team_members WHERE patient_id = p_merged ORDER BY id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM care_team_members s
      WHERE s.patient_id = p_survivor
        AND s.practitioner_id = link.practitioner_id
        AND tstzrange(s.started_at, s.ends_at) && tstzrange(link.started_at, link.ends_at)
    ) THEN
      UPDATE care_team_members SET patient_id = p_survivor WHERE id = link.id;
      moved_link_ids := moved_link_ids || link.id;
    ELSE
      FOR free_piece IN
        SELECT unnest(
          tstzmultirange(tstzrange(link.started_at, link.ends_at))
          - (SELECT range_agg(tstzrange(s.started_at, s.ends_at))
             FROM care_team_members s
             WHERE s.patient_id = p_survivor
               AND s.practitioner_id = link.practitioner_id)
        )
      LOOP
        INSERT INTO care_team_members
          (patient_id, practitioner_id, started_at, ends_at, created_by, ended_by, reason)
        VALUES (
          p_survivor, link.practitioner_id, lower(free_piece), upper(free_piece),
          link.created_by,
          -- The original's ender only for the piece that ends where it did;
          -- a piece cut short by the survivor's own link wasn't ended by anyone.
          CASE WHEN upper(free_piece) IS NOT DISTINCT FROM link.ends_at
               THEN link.ended_by END,
          link.reason
        ) RETURNING id INTO new_link_id;
        new_link_ids := new_link_ids || new_link_id;
      END LOOP;
      IF link.ends_at IS NULL OR link.ends_at > now() THEN
        -- Every link starts when it is made (no route sets a later start),
        -- so now() is never before started_at.
        UPDATE care_team_members
        SET ends_at = now(), ended_by = actor
        WHERE id = link.id;
        ended_link_ids := ended_link_ids || link.id;
      END IF;
    END IF;
  END LOOP;

  -- --- Record access granted or released about this patient -----------------
  -- Complaint reviews and legal disclosures are part of the patient's record
  -- (a disclosure is listed for the patient and in their copy — 164.528), so
  -- they move. An OPEN review is ended first: it was opened on the merged
  -- account's record, and moving it open would silently widen it to the
  -- survivor's; the admin opens a new one if it's still needed.
  WITH ended AS (
    UPDATE complaint_reviews SET ended_at = now(), ended_by = actor
    WHERE patient_id = p_merged AND ended_at IS NULL AND expires_at > now()
    RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO ended_review_ids FROM ended;
  WITH moved AS (
    UPDATE complaint_reviews SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO review_ids FROM moved;

  WITH moved AS (
    UPDATE legal_disclosures SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO disclosure_ids FROM moved;

  -- --- Clinics: the survivor attends every clinic either attended ------------
  -- Clinical access needs a link AND a shared clinic (decisions §3): without
  -- this, a moved link to a practitioner of a clinic only the merged account
  -- attended would give no access. The merged account's own memberships stay.
  WITH added AS (
    INSERT INTO user_clinics (user_id, clinic_id)
    SELECT p_survivor, clinic_id FROM user_clinics WHERE user_id = p_merged
    ON CONFLICT (user_id, clinic_id) DO NOTHING
    RETURNING clinic_id
  ) SELECT coalesce(array_agg(clinic_id ORDER BY clinic_id), '{}') INTO clinic_ids FROM added;

  -- --- What would let the merged account come back ---------------------------
  -- A pending invitation would let someone set a password on it; an open
  -- records-export link would download its (now empty) record. Both closed.
  WITH revoked AS (
    UPDATE invitations SET revoked_at = now(), revoked_by = actor
    WHERE user_id = p_merged AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO invitation_ids FROM revoked;
  WITH closed AS (
    UPDATE records_export_links SET replaced_at = now()
    WHERE patient_id = p_merged AND used_at IS NULL AND replaced_at IS NULL
      AND expires_at > now()
    RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO export_link_ids FROM closed;

  -- --- Profile: the survivor keeps its own, fills its gaps -------------------
  -- The person's choice: only the survivor's EMPTY fields are filled. The
  -- address is one block — all six fields or none — so a street from one
  -- account is never paired with a city from the other.
  IF survivor_row.phone IS NULL AND merged_row.phone IS NOT NULL THEN
    UPDATE users SET phone = merged_row.phone WHERE id = p_survivor;
    filled := filled || 'phone'::text;
  END IF;
  IF num_nonnulls(survivor_row.address_line1, survivor_row.address_line2,
                  survivor_row.address_city, survivor_row.address_state,
                  survivor_row.address_postal_code, survivor_row.address_country) = 0
     AND num_nonnulls(merged_row.address_line1, merged_row.address_line2,
                      merged_row.address_city, merged_row.address_state,
                      merged_row.address_postal_code, merged_row.address_country) > 0 THEN
    UPDATE users SET
      address_line1 = merged_row.address_line1,
      address_line2 = merged_row.address_line2,
      address_city = merged_row.address_city,
      address_state = merged_row.address_state,
      address_postal_code = merged_row.address_postal_code,
      address_country = merged_row.address_country
    WHERE id = p_survivor;
    filled := filled || 'address'::text;
  END IF;
  IF survivor_row.avatar_path IS NULL AND merged_row.avatar_path IS NOT NULL THEN
    -- The survivor takes the file, and the merged account lets go of it: a
    -- photo replaced later deletes the OLD file at once (updateAvatar), so
    -- no second row may still be naming it.
    UPDATE users SET avatar_path = merged_row.avatar_path WHERE id = p_survivor;
    UPDATE users SET avatar_path = NULL WHERE id = p_merged;
    filled := filled || 'avatar'::text;
  END IF;

  -- --- The merged account: deactivated, and the record of the merge ----------
  UPDATE users SET is_active = false WHERE id = p_merged;
  INSERT INTO patient_merges (survivor_id, merged_id, merged_by)
  VALUES (p_survivor, p_merged, actor)
  RETURNING id INTO merge_id;

  RETURN jsonb_build_object(
    'mergeId', merge_id,
    'mergedId', p_merged,
    'survivorId', p_survivor,
    'wasActive', merged_row.is_active,
    'assignedProgramIds', to_jsonb(program_ids),
    'sessionIds', to_jsonb(session_ids),
    'medicalFileIds', to_jsonb(medical_file_ids),
    'movedConversationIds', to_jsonb(moved_conversation_ids),
    'combinedConversations', combined,
    'movedCareTeamLinkIds', to_jsonb(moved_link_ids),
    'newCareTeamLinkIds', to_jsonb(new_link_ids),
    'endedCareTeamLinkIds', to_jsonb(ended_link_ids),
    'complaintReviewIds', to_jsonb(review_ids),
    'endedComplaintReviewIds', to_jsonb(ended_review_ids),
    'legalDisclosureIds', to_jsonb(disclosure_ids),
    'addedClinicIds', to_jsonb(clinic_ids),
    'revokedInvitationIds', to_jsonb(invitation_ids),
    'closedExportLinkIds', to_jsonb(export_link_ids),
    'filledFields', to_jsonb(filled)
  );
END
$$;--> statement-breakpoint

-- Functions are executable by PUBLIC by default — not this one.
REVOKE EXECUTE ON FUNCTION merge_patients(integer, integer) FROM PUBLIC;--> statement-breakpoint

-- The app's role is named by an environment variable a migration can't read
-- (scripts/create-app-role.ts creates it). For a database whose app role
-- already exists, grant it here: the roles that may UPDATE `users` are the
-- app's (the owner owns it and needs no grant). A database set up later gets
-- the grant from create-app-role, which runs after the migrations.
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
    EXECUTE format('GRANT EXECUTE ON FUNCTION merge_patients(integer, integer) TO %I', app_role);
  END LOOP;
END
$$;