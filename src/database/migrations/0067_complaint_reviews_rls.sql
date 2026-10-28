-- Custom SQL migration (the complaint review — decisions §25, pass 2 of the
-- post-Phase-6 tidy-up, decided with the person 2026-10-28): who may read and
-- write a review, its reason and the care team's "seen", and the rules a
-- review's row follows whoever writes it. Tables created by 0066.
--
-- The shape of the access (the "why" is in complaint-reviews.schema.ts):
--   - complaint_reviews: an ADMIN opens one (in their own name), lists them,
--     ends one early; the patient's CARE TEAM reads them — that is how they
--     are told. Never the patient (not told in the app: an internal operations
--     use, HIPAA 164.501 — the person's choice).
--   - complaint_review_reasons: ADMINS only. The care team sees that a review
--     exists, never why (the reason may name a colleague, or the complaint).
--   - complaint_review_notice_reviews: each practitioner's own "seen" — the
--     care_team_join_reviews rules (0065) again, on a review instead of a link.
--
-- What is NOT here, on purpose: any admin branch on a CLINICAL table. A review
-- copy is read by switching the transaction to the PATIENT's own context (the
-- emailed link's path, decisions §20) — so the database never lets an admin
-- read a medical file, and §16 stands as it was. The check that the review is
-- open when a copy is made is therefore the SERVICE's, in the copy's own
-- transaction: a read as the patient leaves the database nothing to compare.

ALTER TABLE complaint_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE complaint_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE complaint_review_reasons ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE complaint_review_reasons FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE complaint_review_notice_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE complaint_review_notice_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- === complaint_reviews ======================================================

-- An admin, or a practitioner on the patient's care team (the function every
-- care-team policy uses — 0019; it requires the practitioner role itself).
CREATE POLICY complaint_reviews_select ON complaint_reviews
  FOR SELECT
  USING (
    rls_is_admin()
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- An admin, in their OWN name: no review opened for someone else.
CREATE POLICY complaint_reviews_insert ON complaint_reviews
  FOR INSERT
  WITH CHECK (rls_is_admin() AND opened_by = rls_current_user_id());--> statement-breakpoint

-- An admin (ending a review early). WHAT may change is the trigger's job
-- below: a policy sees rows, not the difference between OLD and NEW.
CREATE POLICY complaint_reviews_update ON complaint_reviews
  FOR UPDATE
  USING (rls_is_admin())
  WITH CHECK (rls_is_admin());--> statement-breakpoint

-- Delete: deliberately NO policy — a review is ended, never erased.

-- === complaint_review_reasons ===============================================

CREATE POLICY complaint_review_reasons_select ON complaint_review_reasons
  FOR SELECT
  USING (rls_is_admin());--> statement-breakpoint

-- Written by the admin who opened the review, IN THE SAME TRANSACTION:
-- `r.opened_at = now()` — the trigger below stamps opened_at with now(), and
-- now() is the transaction's start, the same value for every statement in
-- it. So a reason can't be added later to a review opened without one, nor
-- by another admin. (The subquery runs under the caller's own row security:
-- an admin sees every review.)
CREATE POLICY complaint_review_reasons_insert ON complaint_review_reasons
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    AND EXISTS (
      SELECT 1 FROM complaint_reviews r
      WHERE r.id = complaint_review_reasons.review_id
        AND r.opened_by = rls_current_user_id()
        AND r.opened_at = now()
    )
  );--> statement-breakpoint

-- No UPDATE, no DELETE policy: a reason is part of the record of the access.

-- === complaint_review_notice_reviews ========================================

-- Own rows only, as a practitioner (the role is checked here because nothing
-- else in this condition does — as in 0065).
CREATE POLICY complaint_review_notice_reviews_select ON complaint_review_notice_reviews
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'practitioner'
    AND practitioner_id = rls_current_user_id()
  );--> statement-breakpoint

-- For oneself, about a review of a patient whose care team one is on. The
-- review's patient is read through complaint_reviews (visibility follows the
-- parent). Whether the review is really a notice FOR me (on the team before
-- it opened, within 14 days) is the service's rule — the one that draws the
-- list.
CREATE POLICY complaint_review_notice_reviews_insert ON complaint_review_notice_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM complaint_reviews r
      WHERE r.id = complaint_review_notice_reviews.complaint_review_id
        AND rls_practitioner_manages_patient(r.patient_id)
    )
  );--> statement-breakpoint

-- === The guards =============================================================
--
-- What the database guarantees about a review, whatever writes the row (the
-- service checks the same things first and answers in its own words; reaching
-- one of these refusals means a bug — a 500, on purpose):
--   - a new review is OPEN; its opening moment is the database's, and it lasts
--     EXACTLY 168 hours (7 days — COMPLAINT_REVIEW_HOURS in the schema file):
--     no bug, and no crafted request, can open a longer one;
--   - what a review IS never changes: its patient, admin and dates;
--   - ending it is final, can't happen once it has expired, is signed by the
--     admin who does it, and is dated by the database.
-- The tables' owner passes untouched (the seed's reset, tests planting rows)
-- — the same exemption as 0062.
--
-- Each refusal is a check_violation (23514) carrying a constraint NAME, like
-- the other guards: tests (and logs) can tell them apart.
CREATE FUNCTION guard_complaint_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
      RAISE EXCEPTION 'A new complaint review must be open'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'complaint_review_starts_open';
    END IF;
    NEW.opened_at := now();
    -- Hours, not days: a fixed length across a daylight-saving change.
    NEW.expires_at := now() + make_interval(hours => 168);
    RETURN NEW;
  END IF;

  -- UPDATE
  -- A row compared with a row: IS DISTINCT FROM treats two NULLs as equal.
  IF (NEW.id, NEW.patient_id, NEW.opened_by, NEW.opened_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.patient_id, OLD.opened_by, OLD.opened_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'What complaint review % is can''t change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'complaint_review_fixed';
  END IF;

  -- Nothing changed at all: nothing to judge.
  IF (NEW.ended_at, NEW.ended_by) IS NOT DISTINCT FROM (OLD.ended_at, OLD.ended_by) THEN
    RETURN NEW;
  END IF;

  IF OLD.ended_at IS NOT NULL OR OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'Complaint review % is over', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'complaint_review_closed';
  END IF;

  IF NEW.ended_by IS DISTINCT FROM rls_current_user_id() THEN
    RAISE EXCEPTION 'Complaint review % is ended in one''s own name', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'complaint_review_ended_by_self';
  END IF;

  NEW.ended_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER complaint_review_guard
  BEFORE INSERT OR UPDATE ON complaint_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_complaint_review();--> statement-breakpoint

-- reviewed_at is the database's now() — 0065's trigger, for this table.
CREATE FUNCTION guard_complaint_review_notice_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER complaint_review_notice_review_guard
  BEFORE INSERT ON complaint_review_notice_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_complaint_review_notice_review();