-- Custom SQL migration (the care-team join notice — decisions §25, pass 1 of
-- the post-Phase-6 tidy-up, decided with the person 2026-10-28): who may read
-- and write a join review, and the one rule its row follows whoever writes it.
--
-- A join review is ONE practitioner's "I've seen that a colleague joined this
-- patient's care team" — their own workflow, like a session review (0044), but
-- narrower:
--   - READ: only the practitioner who wrote it. Nobody else's list depends on
--     it (each member reviews for themselves), the patient has no branch (staff
--     workflow), and an admin has none either: a review says nothing an admin
--     needs — the join itself is in the audit log (CARE_TEAM_JOINED /
--     _MEMBER_ADDED), and the review too (CARE_TEAM_JOIN_REVIEWED).
--   - WRITE: a practitioner, for THEMSELVES (practitioner_id is the session
--     user's own id), about a link on a patient whose care team they are on.
--     Whether the link is really a notice FOR them (a colleague's newer link,
--     within 14 days) is the service's rule — the same one that draws the
--     list; the database guarantees who and whose patient.
--   - No UPDATE, no DELETE policy: a review is a record, written once. Under
--     FORCE ROW LEVEL SECURITY a missing policy refuses the command outright.
--
-- Who the care team is: rls_practitioner_manages_patient() — the function
-- every care-team policy uses (0019: an active link AND a shared clinic; it
-- also requires the active role to be practitioner).

ALTER TABLE care_team_join_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE care_team_join_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Own rows only, as a practitioner. (The role is checked here because nothing
-- else in this condition does: a practitioner + patient account acting as a
-- patient sees no reviews.)
CREATE POLICY care_team_join_reviews_select ON care_team_join_reviews
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'practitioner'
    AND practitioner_id = rls_current_user_id()
  );--> statement-breakpoint

-- The link's patient is read through care_team_members (a review has no
-- patient_id of its own — visibility always follows the parent, never a second
-- copy that could disagree). That subquery runs under the caller's RLS too.
-- (No separate role test: the care-team function requires the practitioner
-- role, so an admin or a patient fails there.)
CREATE POLICY care_team_join_reviews_insert ON care_team_join_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM care_team_members l
      WHERE l.id = care_team_join_reviews.care_team_member_id
        AND rls_practitioner_manages_patient(l.patient_id)
    )
  );--> statement-breakpoint

-- reviewed_at is the database's now(): the column's default is only a default,
-- and a client could send any moment; this BEFORE INSERT trigger overwrites it,
-- so "reviewed on" is the server's clock, like a session review's (0044). The
-- tables' owner is NOT exempt (nothing needs it).
CREATE FUNCTION guard_care_team_join_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER care_team_join_review_guard
  BEFORE INSERT ON care_team_join_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_care_team_join_review();