-- Custom SQL migration (Phase 6 — medical files, decided with the person
-- 2026-10-20): the database's half of the medical file rules, brought to the
-- standard messaging set in 0048. The service follows each rule too
-- (medical-files.service.ts); these make them hold for ANY query under the
-- app's role.
--
--   1. READING: the patient themselves, and the practitioners on their care
--      team. Admins no longer read medical files — the person's choice, the
--      same as messages (0048): entries are clinical content, admins aren't
--      on care teams (HIPAA's "minimum necessary"); oversight comes from the
--      audit trail. An admin who also holds the practitioner role reads them
--      when acting as a practitioner on the care team, like anyone else.
--   2. WRITING: unchanged since 0019 — a practitioner, as themselves, for a
--      patient on their care team. Not re-created here.
--   3. NEVER CHANGED, NEVER REMOVED: still no UPDATE and no DELETE policy, so
--      under row security the app's role matches no row to change or remove
--      (an UPDATE or DELETE "succeeds" on 0 rows). Corrections are new rows
--      — amendments (0049).
--   4. THE MOMENT: an entry's created_at is the database's now(). The
--      column's DEFAULT is only a default; the trigger below overwrites
--      whatever a client sent, so no entry can be backdated (or dated in the
--      future) through the app.
--
-- Only the APP is guarded: the table's OWNER (migrations, the dev seed —
-- which writes past entries with past moments — and the e2e tests' set-up)
-- is exempt, found from the catalog with no role name written here (0031
-- explains why).

-- === 1. Reading: the patient and their care team ==============================

-- 0019's policy without its first branch, rls_is_admin().
DROP POLICY medical_files_select ON medical_files;--> statement-breakpoint
CREATE POLICY medical_files_select ON medical_files
  FOR SELECT
  USING (
    (current_setting('app.current_role', true) = 'patient'
      AND patient_id = rls_current_user_id())
    OR rls_practitioner_manages_patient(patient_id)
  );--> statement-breakpoint

-- === 4. The moment an entry was written ======================================

-- The same shape as the messages' insert guard (0048) and the session
-- reviews' (0044): the owner passes untouched; anyone else's row gets the
-- database's clock. now() is the transaction's start — one instant for the
-- entry AND its audit entry, written in the same transaction.
CREATE FUNCTION guard_medical_file_insert() RETURNS trigger
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

CREATE TRIGGER medical_file_insert_guard
  BEFORE INSERT ON medical_files
  FOR EACH ROW EXECUTE FUNCTION guard_medical_file_insert();