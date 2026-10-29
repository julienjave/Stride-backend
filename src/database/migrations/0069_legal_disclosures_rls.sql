-- Custom SQL migration (the legal disclosure — decisions §25, pass 3 of the
-- post-Phase-6 tidy-up, designed with the person 2026-10-28): who may read and
-- write a disclosure and its three companion tables, and the rules a
-- disclosure's row follows whoever writes it. Tables created by 0068; WHY
-- there are four is in legal-disclosures.schema.ts.
--
-- The shape of the access:
--   - legal_disclosures (who received it, when, the hold): ADMINS make them
--     (in their own name) and read them all; the patient's CARE TEAM reads
--     them — that is how they are told; the PATIENT reads their own, once
--     the hold (if any) is over — their accounting of disclosures.
--   - legal_disclosure_details (the legal basis, the parts, the period):
--     admins, and the patient through the same release rule. NOT the care
--     team (the person's choice).
--   - legal_disclosure_orders (the reference, the day received, the agency's
--     statement): ADMINS only.
--   - legal_disclosure_notice_reviews: each practitioner's own "seen" — 0067's
--     rules for complaint reviews, on a disclosure.
--
-- What is NOT here, on purpose (as in 0067): any admin branch on a CLINICAL
-- table. The disclosed copy is read by switching the transaction to the
-- PATIENT's own context — so the database never lets an admin read a medical
-- file or a message, and decisions §16 stands as it was. Messages are read the
-- same way: through the conversations the PATIENT can read.
--
-- Nothing is ever changed or removed: no UPDATE and no DELETE policy on any
-- of the four tables. Under FORCE ROW LEVEL SECURITY a table without such a
-- policy refuses every UPDATE and DELETE from the app's role (they match no
-- row) — a disclosure, once made, is a fact about the past.

ALTER TABLE legal_disclosures ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosures FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_details ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_details FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_orders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_orders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_notice_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_disclosure_notice_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- === legal_disclosures =======================================================

-- Three readers, three branches:
--   - an admin: every disclosure;
--   - a practitioner on the patient's care team (rls_practitioner_manages_
--     patient requires the practitioner role itself — 0019);
--   - the patient, acting as a patient, their OWN disclosures — once
--     released. The hold is decided HERE, on the database's clock: while
--     withheld_until is in the future, the row doesn't exist for the patient,
--     whichever screen or export asks (HIPAA 164.528(a)(2)).
CREATE POLICY legal_disclosures_select ON legal_disclosures
  FOR SELECT
  USING (
    rls_is_admin()
    OR rls_practitioner_manages_patient(patient_id)
    OR (
      current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id()
      AND (withheld_until IS NULL OR withheld_until <= now())
    )
  );--> statement-breakpoint

-- An admin, in their OWN name: no disclosure recorded for someone else.
CREATE POLICY legal_disclosures_insert ON legal_disclosures
  FOR INSERT
  WITH CHECK (rls_is_admin() AND made_by = rls_current_user_id());--> statement-breakpoint

-- === legal_disclosure_details ================================================

-- An admin; or the patient, through their view of the PARENT: the subquery
-- runs under the caller's own row security, so it finds the disclosure only
-- when legal_disclosures_select shows it to them — their own, released. One
-- release rule, written once. The role is checked here because a
-- practitioner also sees the parent, and must not see this.
CREATE POLICY legal_disclosure_details_select ON legal_disclosure_details
  FOR SELECT
  USING (
    rls_is_admin()
    OR (
      current_setting('app.current_role', true) = 'patient'
      AND EXISTS (
        SELECT 1 FROM legal_disclosures d
        WHERE d.id = legal_disclosure_details.disclosure_id
      )
    )
  );--> statement-breakpoint

-- Written by the admin who made the disclosure, IN THE SAME TRANSACTION:
-- `d.made_at = now()` — the trigger below stamps made_at with now(), and
-- now() is the transaction's start, the same value for every statement in it
-- (0067's reasoning for a review's reason). Details can't be added later to
-- a disclosure, nor by another admin.
CREATE POLICY legal_disclosure_details_insert ON legal_disclosure_details
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    AND EXISTS (
      SELECT 1 FROM legal_disclosures d
      WHERE d.id = legal_disclosure_details.disclosure_id
        AND d.made_by = rls_current_user_id()
        AND d.made_at = now()
    )
  );--> statement-breakpoint

-- === legal_disclosure_orders =================================================

CREATE POLICY legal_disclosure_orders_select ON legal_disclosure_orders
  FOR SELECT
  USING (rls_is_admin());--> statement-breakpoint

-- The details' rule, plus one across the two tables: the agency's statement
-- is present EXACTLY when the disclosure is held back. A hold without its
-- documented request — or a statement for a hold that doesn't exist — can't
-- be written.
CREATE POLICY legal_disclosure_orders_insert ON legal_disclosure_orders
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    AND EXISTS (
      SELECT 1 FROM legal_disclosures d
      WHERE d.id = legal_disclosure_orders.disclosure_id
        AND d.made_by = rls_current_user_id()
        AND d.made_at = now()
        AND (d.withheld_until IS NULL)
            = (legal_disclosure_orders.withholding_statement IS NULL)
    )
  );--> statement-breakpoint

-- === legal_disclosure_notice_reviews =========================================

-- Own rows only, as a practitioner (0067's notice reviews, again).
CREATE POLICY legal_disclosure_notice_reviews_select ON legal_disclosure_notice_reviews
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'practitioner'
    AND practitioner_id = rls_current_user_id()
  );--> statement-breakpoint

-- For oneself, about a disclosure of a patient whose care team one is on
-- (visibility follows the parent). Whether it is really a notice FOR me (on
-- the team before it was made, within 14 days) is the service's rule.
CREATE POLICY legal_disclosure_notice_reviews_insert ON legal_disclosure_notice_reviews
  FOR INSERT
  WITH CHECK (
    practitioner_id = rls_current_user_id()
    AND EXISTS (
      SELECT 1 FROM legal_disclosures d
      WHERE d.id = legal_disclosure_notice_reviews.disclosure_id
        AND rls_practitioner_manages_patient(d.patient_id)
    )
  );--> statement-breakpoint

-- === The guards ==============================================================
--
-- What the database guarantees about a NEW disclosure, whatever writes it (the
-- service checks the hold first and answers in its own words; reaching the
-- refusal below means a bug — a 500, on purpose):
--   - its moment is the database's: made_at := now(), so no request can date
--     a disclosure before or after it happened;
--   - a hold ends in the FUTURE: a withheld_until already past would be a
--     hold that never held.
-- No UPDATE branch: there is no UPDATE policy, so the app can't change a row.
-- The tables' owner passes untouched (the seed's reset, tests planting rows)
-- — 0067's exemption.
CREATE FUNCTION guard_legal_disclosure() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;

  NEW.made_at := now();
  IF NEW.withheld_until IS NOT NULL AND NEW.withheld_until <= now() THEN
    RAISE EXCEPTION 'A disclosure can only be held back until a moment in the future'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'legal_disclosure_hold_in_future';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER legal_disclosure_guard
  BEFORE INSERT ON legal_disclosures
  FOR EACH ROW EXECUTE FUNCTION guard_legal_disclosure();--> statement-breakpoint

-- reviewed_at is the database's now() — 0067's trigger, for this table.
CREATE FUNCTION guard_legal_disclosure_notice_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER legal_disclosure_notice_review_guard
  BEFORE INSERT ON legal_disclosure_notice_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_legal_disclosure_notice_review();