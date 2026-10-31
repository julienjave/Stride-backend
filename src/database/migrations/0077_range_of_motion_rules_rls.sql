-- Custom SQL migration (practitioner-measured range of motion, pass 1 —
-- decided with the person 2026-10-31): the rules of the two tables 0076
-- created, which a schema file can't express. Four parts:
--   1. row-level security — who reads and writes an assessment and its
--      measurements;
--   2. the moment an assessment was recorded is the database's clock;
--   3. an assessment holds at least one measurement (a DEFERRED check);
--   4. merge_patients() (0072) moves assessments too.
--
-- The model is the medical file's (0019 / 0050): the patient reads their own,
-- the practitioners on their care team read and record; admins see nothing;
-- nothing is ever updated or deleted. The tables' OWNER (migrations, the dev
-- seed, the e2e set-up, the merge's definer function) is exempt from the
-- clock rule only, as in 0050.

-- === 1. Row-level security ====================================================

ALTER TABLE rom_assessments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE rom_assessments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE rom_measurements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE rom_measurements FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Reading an assessment: the medical file's policy (0050), word for word —
-- the patient their own, the care team theirs, nobody else (no admin
-- branch: decisions §16).
CREATE POLICY rom_assessments_select ON rom_assessments
  FOR SELECT
  USING (
    (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- Recording one: a practitioner on the patient's care team, as themselves
-- (no forged author). The care team is asked AT THE MOMENT OF WRITING — a
-- link ended a second earlier refuses the insert (42501 → the API's 403).
CREATE POLICY rom_assessments_insert ON rom_assessments
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND created_by = rls_current_user_id()
    AND rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- No UPDATE and no DELETE policy, deliberately: with row security on, an
-- operation no policy allows matches no rows. APPEND-ONLY, as medical_files.

-- Reading a measurement: whoever may read its assessment. The subquery runs
-- under the CALLER's row security, so `EXISTS` is true exactly when the
-- caller can see that assessment — the assessment's policy decides for both
-- tables, written once (session_exercises' idiom, 0004).
CREATE POLICY rom_measurements_select ON rom_measurements
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM rom_assessments a WHERE a.id = rom_measurements.assessment_id)
  );--> statement-breakpoint

-- Adding a measurement: ONLY to an assessment the caller recorded IN THIS
-- TRANSACTION. now() is the transaction's start, and the insert trigger
-- (below) stamps an assessment with exactly that value — so `created_at =
-- now()` holds only in the transaction that wrote it. Once it commits, no
-- later transaction (whose now() is later) can add a value to it: the
-- assessment's measurements are fixed for good, which is what "append-only"
-- has to mean for a record made of two tables. (A correction is a new,
-- complete assessment — an amendment.)
CREATE POLICY rom_measurements_insert ON rom_measurements
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND EXISTS (
      SELECT 1 FROM rom_assessments a
      WHERE a.id = rom_measurements.assessment_id
        AND a.created_by = rls_current_user_id()
        AND a.created_at = now()
    )
  );--> statement-breakpoint

-- === 2. The moment an assessment was recorded =================================

-- The medical file's insert guard (0050): the owner passes untouched (the
-- seed writes past assessments with past moments); anyone else's row gets the
-- database's now(). It runs BEFORE the row's CHECKs, so
-- rom_assessments_measured_by_recording compares the measurement day with
-- THIS moment — for the app, "not in the future".
CREATE FUNCTION guard_rom_assessment_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER rom_assessment_insert_guard
  BEFORE INSERT ON rom_assessments
  FOR EACH ROW EXECUTE FUNCTION guard_rom_assessment_insert();--> statement-breakpoint

-- === 3. An assessment holds at least one measurement ==========================

-- medical_files has the same rule as a CHECK (an entry needs a section). Here
-- the content is in ANOTHER table, which a CHECK can't read — and at the
-- moment the assessment row is inserted its measurements can't exist yet
-- (they point at it). So the question is asked LATER: a CONSTRAINT TRIGGER,
-- DEFERRABLE INITIALLY DEFERRED, runs at COMMIT, once the transaction has
-- written everything. An assessment committed with no measurement raises
-- 23514 and the whole transaction rolls back. With policy 1's "only in the
-- same transaction", it means: an assessment is born complete, and stays so.
--
-- For EVERYONE, the owner included (unlike the clock rule): an empty
-- assessment is never right, and the seed writes each one with its values in
-- one transaction anyway. The API never reaches it (the DTO asks for at least
-- one); it is the database's half of the rule, for a direct query.
--
-- SECURITY INVOKER (the default) is enough: it runs as the inserting role,
-- which may read the measurements it just wrote (their policy reads the
-- assessment, which the same care team can see).
CREATE FUNCTION check_rom_assessment_has_measurements() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rom_measurements WHERE assessment_id = NEW.id) THEN
    RAISE EXCEPTION 'Range-of-motion assessment % has no measurement', NEW.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'rom_assessments_has_measurements';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER rom_assessments_has_measurements
  AFTER INSERT ON rom_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_rom_assessment_has_measurements();--> statement-breakpoint

-- === 4. merge_patients(): assessments move with the medical file ==============
--
-- 0072's function, REPLACED with two changes (everything else is unchanged,
-- line for line):
--   - the medical file and the assessments move in ONE statement. An
--     assessment's link to its note is a foreign key on (entry, patient):
--     moving the notes first would leave a linked assessment pointing at
--     (entry, old patient) — gone — and moving the assessments first would
--     point at (entry, new patient) — not there yet. Postgres checks a
--     foreign key at the END OF THE STATEMENT, and a WITH holding several
--     UPDATEs is ONE statement: by its end both tables have moved together,
--     and every key holds. (0072 used the same fact for an amendment and its
--     original, within one table.) Measurements belong to their assessment
--     and need no move.
--   - the answer lists the assessments moved (`romAssessmentIds`) — the
--     audit entry's record of what moved (PATIENT_MERGE_RECORDS_MOVED).
-- CREATE OR REPLACE keeps the function's owner and its grants (EXECUTE for
-- the app's role only), so nothing needs granting again.

CREATE OR REPLACE FUNCTION merge_patients(p_merged integer, p_survivor integer)
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
  rom_assessment_ids integer[];
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
  -- Range-of-motion assessments (0077) in that SAME statement: an assessment
  -- points at its note by (entry, patient_id), so the two tables must move
  -- together too — a WITH with two UPDATEs is one statement. Their
  -- measurements belong to the assessment and stay with it.
  WITH moved AS (
    UPDATE assigned_programs SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO program_ids FROM moved;

  WITH moved AS (
    UPDATE sessions SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO session_ids FROM moved;

  WITH moved_entries AS (
    UPDATE medical_files SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ), moved_assessments AS (
    UPDATE rom_assessments SET patient_id = p_survivor
    WHERE patient_id = p_merged RETURNING id
  ) SELECT
      (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM moved_entries),
      (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM moved_assessments)
    INTO medical_file_ids, rom_assessment_ids;

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
    'romAssessmentIds', to_jsonb(rom_assessment_ids),
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