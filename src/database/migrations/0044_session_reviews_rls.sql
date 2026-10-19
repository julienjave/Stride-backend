-- Custom SQL migration (the practitioner home's To-do, decided with the
-- person 2026-10-19): who may read and write a session review, and the two
-- rules a review's row must follow whoever writes it.
--
-- A review is the care team's workflow, not the patient's report: "Sam
-- looked at this session". So:
--   - READ: an admin, or a practitioner on the session's patient's care
--     team — the same people who may read the session itself. The PATIENT
--     has no branch: the To-do is staff workflow (decided 2026-10-19), and
--     what they reported is already theirs to read in the session.
--   - WRITE: a practitioner, for THEMSELVES (practitioner_id is the session
--     user's own id — nobody marks a session reviewed in a colleague's
--     name), on a session of a patient whose care team they are on. Not an
--     admin: reviewing is clinical work.
--   - No UPDATE, no DELETE policy: a review is a record, written once. Under
--     FORCE ROW LEVEL SECURITY a missing policy refuses the command outright.
--
-- Who the care team is: rls_practitioner_manages_patient() — the function
-- every care-team policy uses (0019: an active link AND a shared clinic; it
-- also requires the active role to be practitioner).

ALTER TABLE session_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE session_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The session's patient is read through the sessions table: a review has no
-- patient_id of its own (the same shape as session_exercises — visibility
-- always follows the parent, never a second copy that could disagree). The
-- subquery runs under the caller's RLS too, so a session they can't see
-- can't make a review visible.
CREATE POLICY session_reviews_select ON session_reviews
  FOR SELECT
  USING (
    rls_is_admin()
    OR EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_reviews.session_id
        AND rls_practitioner_manages_patient(s.patient_id)
    )
  );--> statement-breakpoint

-- (No separate "the role is practitioner" test: the care-team function
-- already requires it, so an admin or a patient fails there.)
CREATE POLICY session_reviews_insert ON session_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_reviews.session_id
        AND rls_practitioner_manages_patient(s.patient_id)
    )
  );--> statement-breakpoint

-- The row's own rules, as a BEFORE INSERT trigger (like 0038 / 0041):
--   1. reviewed_at is the database's now() — the column's default is only a
--      default, and a client could send any moment; the trigger overwrites
--      it, so "reviewed on" is the server's clock, like every session moment;
--   2. a session still IN PROGRESS can't be reviewed: there is nothing final
--      to read yet (the patient may still stop it, or rate an exercise 9).
--      Unreachable through the API today — SessionReviewsService refuses
--      first, and a session never goes back to in progress — so this is the
--      database's half of the rule, for any query under the app's role.
-- Unlike 0038 / 0041, the tables' OWNER is NOT exempt: nothing needs it to
-- write a review differently — the dev seed records its review through the
-- app's own service — and an exception nobody uses is one more thing to
-- trust.
CREATE FUNCTION guard_session_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id AND s.status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'Session % is still in progress, so it can''t be reviewed yet', NEW.session_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'session_review_finished_only',
            TABLE = TG_TABLE_NAME;
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER session_review_guard
  BEFORE INSERT ON session_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_session_review();