-- Custom SQL migration (the practitioner's "For review" list, 2026-10-19):
-- who may read and write a program alert review, and its moment. The same
-- shape as 0044 (session_reviews), for the same reasons:
--   - READ: an admin, or a practitioner on the program's patient's care
--     team. Not the patient: "For review" is the staff's workflow.
--   - WRITE: a practitioner, in their OWN name, on their care team (the
--     care-team function also requires the practitioner role, so an admin
--     or a patient fails there).
--   - No UPDATE, no DELETE policy: a review is a permanent record.
-- The program's patient is read through assigned_programs (a review has no
-- patient_id of its own): visibility follows the parent, under the
-- caller's own row security.

ALTER TABLE program_alert_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE program_alert_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY program_alert_reviews_select ON program_alert_reviews
  FOR SELECT
  USING (
    rls_is_admin()
    OR EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_alert_reviews.assigned_program_id
        AND rls_practitioner_manages_patient(ap.patient_id)
    )
  );--> statement-breakpoint

CREATE POLICY program_alert_reviews_insert ON program_alert_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM assigned_programs ap
      WHERE ap.id = program_alert_reviews.assigned_program_id
        AND rls_practitioner_manages_patient(ap.patient_id)
    )
  );--> statement-breakpoint

-- reviewed_at is the database's now(), whatever is sent — the column's
-- default is only a default. It matters more here than for a session
-- review: the 14-day reminder is counted from this moment, so a client
-- sending an old date would hide an alert for less time, a future one for
-- longer. No exemption for the tables' owner (0044's reasoning: nothing
-- needs one).
CREATE FUNCTION guard_program_alert_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER program_alert_review_guard
  BEFORE INSERT ON program_alert_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_program_alert_review();