-- Custom SQL migration file, put your code below! --
--
-- The care team becomes the access rule (design decisions §3, "Care team
-- and accounts", decided 2026-09-27). Until now a practitioner "managed" a
-- patient when they shared a clinic; from now on clinical access requires
-- being on the patient's CARE TEAM (an active link in care_team_members,
-- created by 0018) AND still sharing a clinic. Sharing a clinic alone only
-- gives directory access, which is enforced in the application
-- (CareTeamService), not here.
--
-- The rule is defined ONCE in SQL, in rls_care_team_member() below, and
-- every policy reaches it:
--   - rls_practitioner_manages_patient() (0003) is REPLACED to call it, so
--     every policy that already used that function switches automatically:
--     assigned_programs and its exercises (0003), sessions (0004), users
--     (0007), user_roles (0009), the three profile tables (0010);
--   - conversations_insert (0005) used rls_clinic_overlap(): recreated;
--   - medical_files (0001) had the clinic join written INSIDE both of its
--     policies, from before the shared functions existed: recreated to use
--     rls_practitioner_manages_patient(), which removes that third copy.
-- rls_clinic_overlap() stays, now meaning DIRECTORY level only (it's what
-- lets a colleague see a patient's care team, below).
--
-- Its TypeScript twin is CareTeamService.isOnCareTeam();
-- test/care-team.e2e-spec.ts runs the same scenarios through both and
-- requires identical answers.
--
-- ORDER MATTERS in this file:
--   1. the extension and the exclusion constraint;
--   2. the BACKFILL;
--   3. only then ENABLE / FORCE ROW LEVEL SECURITY and the policies.
-- FORCE applies RLS to the table's owner too. Migrations run as a superuser
-- today (which bypasses RLS entirely), but if they ever ran as a plain
-- owner, a backfill placed after step 3 would insert under policies that
-- refuse a context-less INSERT — and fail.

-- === 1. No overlapping periods for the same pair ==========================

-- btree_gist lets a GiST index — the kind that understands ranges and
-- overlaps — also compare plain integers with "=". The exclusion constraint
-- below needs both in one index. A standard extension shipped with Postgres;
-- since Postgres 13 it is "trusted", so the database owner can enable it
-- without superuser rights.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- "No two rows with the same patient AND the same practitioner AND
-- overlapping periods." A UNIQUE constraint can only say "not equal"; an
-- EXCLUDE constraint takes any operator — here && ("overlaps") on the
-- period, as a timestamp range.
--   - tstzrange(started_at, ends_at): a NULL end means "unbounded", so an
--     open-ended link overlaps every later period, as it should.
--   - The default bounds are [start, end): the end instant is NOT part of
--     the period, so a new link may start exactly when the previous one
--     ended.
-- It's also what makes two simultaneous "Join" clicks safe: the database
-- decides atomically, and the loser gets SQLSTATE 23P01, which
-- CareTeamService turns into a 409 (isExclusionViolation in pg-errors.ts).
-- The name is referenced by CARE_TEAM_NO_OVERLAP in pg-errors.ts.
ALTER TABLE care_team_members
  ADD CONSTRAINT care_team_members_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    practitioner_id WITH =,
    tstzrange(started_at, ends_at) WITH &&
  );--> statement-breakpoint

-- === 2. Backfill: nobody loses access on the day of the switch ============

-- One open-ended link for every patient/practitioner pair that shares a
-- clinic today — i.e. exactly the old rule, reproduced as data. Admins (or
-- practitioners themselves) end the links that don't reflect real care.
-- created_by stays NULL: nobody created these by hand, and the reason says
-- where they came from.
-- DISTINCT: a pair sharing TWO clinics must get one link, not two (the
-- exclusion constraint above would reject the second anyway).
INSERT INTO care_team_members (patient_id, practitioner_id, created_by, reason)
SELECT DISTINCT
  patient_membership.user_id,
  practitioner_membership.user_id,
  NULL::integer,
  'Backfilled: shared a clinic before care teams existed'
FROM user_clinics patient_membership
JOIN user_roles patient_role
  ON patient_role.user_id = patient_membership.user_id
 AND patient_role.role = 'patient'
JOIN user_clinics practitioner_membership
  ON practitioner_membership.clinic_id = patient_membership.clinic_id
JOIN user_roles practitioner_role
  ON practitioner_role.user_id = practitioner_membership.user_id
 AND practitioner_role.role = 'practitioner'
-- A practitioner + patient account is never on its own care team.
WHERE patient_membership.user_id <> practitioner_membership.user_id;--> statement-breakpoint

-- === 3. The rule, and the table's own policies ============================

-- THE rule, role-agnostic: is `p_practitioner_id` on `p_patient_id`'s care
-- team right now? Active period (started, not ended — a future ends_at is a
-- planned cover, still active) AND a clinic both still share.
--
-- SECURITY INVOKER (the default): it runs with the privileges and RLS
-- context of whoever's query triggered it, so it only sees the
-- care_team_members rows that person may see — their own links for a
-- practitioner, their own team for a patient, everything for an admin.
-- That's exactly the set it needs in every caller.
CREATE FUNCTION rls_care_team_member(p_practitioner_id integer, p_patient_id integer)
  RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1
      FROM care_team_members ctm
      WHERE ctm.practitioner_id = p_practitioner_id
        AND ctm.patient_id = p_patient_id
        AND ctm.started_at <= now()
        AND (ctm.ends_at IS NULL OR ctm.ends_at > now())
    )
    AND rls_clinic_overlap(p_practitioner_id, p_patient_id);
  $$;--> statement-breakpoint

ALTER TABLE care_team_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE care_team_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: an admin; the patient (their own team, history included); a
-- practitioner for their own links, OR for any patient they share a clinic
-- with — directory level: seeing who treats a patient tells a colleague
-- whom to ask and whether to join. Who is on a team is not clinical data.
CREATE POLICY care_team_members_select ON care_team_members
  FOR SELECT
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'patient'
        AND patient_id = rls_current_user_id())
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND (practitioner_id = rls_current_user_id()
             OR rls_clinic_overlap(rls_current_user_id(), patient_id)))
  );--> statement-breakpoint

-- Insert: always recorded as created by the person inserting (no forged
-- "created by"), and either an admin, or a practitioner who shares a clinic
-- with the patient adding a practitioner who does too — "join" (themselves)
-- or "add a colleague". No approval step: decisions §3, "break-glass".
CREATE POLICY care_team_members_insert ON care_team_members
  FOR INSERT
  WITH CHECK (
    created_by = rls_current_user_id()
    AND (
      rls_is_admin()
      OR (current_setting('app.current_role', true) = 'practitioner'
          AND rls_clinic_overlap(rls_current_user_id(), patient_id)
          AND rls_clinic_overlap(practitioner_id, patient_id))
    )
  );--> statement-breakpoint

-- Update = ending a link: an admin, or the practitioner on the link — and
-- always recorded as ended by the person doing it.
CREATE POLICY care_team_members_update ON care_team_members
  FOR UPDATE
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'practitioner'
        AND practitioner_id = rls_current_user_id())
  )
  WITH CHECK (
    ended_by = rls_current_user_id()
    AND (
      rls_is_admin()
      OR (current_setting('app.current_role', true) = 'practitioner'
          AND practitioner_id = rls_current_user_id())
    )
  );--> statement-breakpoint

-- Delete: deliberately NO policy. With RLS enabled, an operation that no
-- policy allows matches no rows — a DELETE here always affects 0 rows. Links
-- are ended, never deleted: "who treated this patient, and when" is kept.

-- === 4. Every existing policy switches to the care team ===================

-- Same name, same parameter (CREATE OR REPLACE can't rename either), new
-- body: every policy calling it now asks the care-team question.
CREATE OR REPLACE FUNCTION rls_practitioner_manages_patient(target_patient_id integer)
  RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.current_role', true) = 'practitioner'
      AND rls_care_team_member(rls_current_user_id(), target_patient_id);
  $$;--> statement-breakpoint

-- Starting a conversation — by the practitioner or by the patient — requires
-- a care-team relationship (was: a shared clinic). rls_care_team_member() is
-- role-agnostic, which is what the patient-initiated branch needs.
DROP POLICY conversations_insert ON conversations;--> statement-breakpoint
CREATE POLICY conversations_insert ON conversations
  FOR INSERT
  WITH CHECK (
    (current_setting('app.current_role', true) = 'practitioner'
      AND practitioner_id = rls_current_user_id()
      AND rls_care_team_member(practitioner_id, patient_id))
    OR
    (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id()
      AND rls_care_team_member(practitioner_id, patient_id))
  );--> statement-breakpoint

-- medical_files: the same meaning as before for admins and patients; the
-- practitioner branch now goes through the shared function instead of its
-- own copy of the clinic join.
DROP POLICY medical_files_select ON medical_files;--> statement-breakpoint
CREATE POLICY medical_files_select ON medical_files
  FOR SELECT
  USING (
    rls_is_admin()
    OR (current_setting('app.current_role', true) = 'patient'
        AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

DROP POLICY medical_files_insert ON medical_files;--> statement-breakpoint
CREATE POLICY medical_files_insert ON medical_files
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND created_by = rls_current_user_id()
    AND rls_practitioner_manages_patient(patient_id)
  );