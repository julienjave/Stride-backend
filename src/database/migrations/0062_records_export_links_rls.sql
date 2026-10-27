-- Custom SQL migration file, put your code below! --
--
-- Row-level security and the guard trigger for records_export_links (table
-- created by 0061; the records export's emailed link, decisions §20).
--
-- Who may touch a link:
--   - an ADMIN, signed in: sending one (and with it, replacing the open
--     one), reading the history, recording that the email went out;
--   - the holder of the TOKEN (the link in the email): reading that one
--     link, counting a wrong date of birth on it, using it.
-- Nobody else: a practitioner never sends a patient's record anywhere, and
-- the patient — signed in — downloads from My records instead.
--
-- THE TOKEN BRANCH works like the invitation's (0021) and the email
-- change's (0054): the download page is used without a session, so the app
-- proves it holds a token by putting the token's HASH in a
-- transaction-local setting (withRecordsExportTokenContext, rls-context.ts);
-- the policies let that transaction see exactly the one row with that hash.
-- On a pooled connection a setting a previous request used reads '' — no
-- token hash is '' (64 hex characters), so it matches nothing.

ALTER TABLE records_export_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE records_export_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY records_export_links_select ON records_export_links
  FOR SELECT
  USING (
    rls_is_admin()
    OR token_hash = current_setting('app.records_export_token_hash', true)
  );--> statement-breakpoint

-- Insert: an admin, recorded as the sender (no forged "sent by"). Never a
-- token holder: a link can be used, never create another.
CREATE POLICY records_export_links_insert ON records_export_links
  FOR INSERT
  WITH CHECK (rls_is_admin() AND sent_by = rls_current_user_id());--> statement-breakpoint

-- Update: an admin (replacing a link, recording the email) or the token
-- holder (a wrong date of birth, the download). WHICH changes each may make
-- is the trigger's job below: a policy sees rows, not the difference between
-- OLD and NEW.
CREATE POLICY records_export_links_update ON records_export_links
  FOR UPDATE
  USING (
    rls_is_admin()
    OR token_hash = current_setting('app.records_export_token_hash', true)
  )
  WITH CHECK (
    rls_is_admin()
    OR token_hash = current_setting('app.records_export_token_hash', true)
  );--> statement-breakpoint

-- Delete: deliberately NO policy — a link is closed, never erased.

-- === The guard ==============================================================
--
-- What the database guarantees, whatever writes the row (the service checks
-- the same things first and answers with its own words; reaching one of
-- these refusals means a bug — a 500, on purpose):
--   - a new link is OPEN, never counted, never emailed yet; its created_at
--     is the database's moment;
--   - what a link IS never changes: its patient, token, sender and dates;
--   - "the email went out" is written once, at the database's moment —
--     even on a link already closed (the email is sent after the commit; a
--     newer link may have replaced it in between);
--   - a CLOSED link (used, replaced, or locked by 5 wrong dates of birth) is
--     final;
--   - a wrong date of birth adds exactly ONE, and only through the link;
--   - USING the link needs the link, before the expiry by the database's
--     clock; replacing it needs an admin; both moments are the database's.
-- The tables' owner passes untouched (the seed's reset, tests planting
-- rows) — the same exemption as 0031, 0033, 0048, 0050, 0054.
--
-- Each refusal is a check_violation (23514) carrying a constraint NAME, like
-- the other guards: tests (and logs) can tell them apart.
CREATE FUNCTION guard_records_export_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  link_token text := current_setting('app.records_export_token_hash', true);
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL OR NEW.replaced_at IS NOT NULL
       OR NEW.email_sent_at IS NOT NULL OR NEW.dob_failures <> 0 THEN
      RAISE EXCEPTION 'A new records export link must be open'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_starts_open';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  -- A row compared with a row: IS DISTINCT FROM treats two NULLs as equal.
  IF (NEW.id, NEW.patient_id, NEW.token_hash, NEW.sent_by, NEW.created_at,
      NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.patient_id, OLD.token_hash, OLD.sent_by, OLD.created_at,
      OLD.expires_at) THEN
    RAISE EXCEPTION 'What records export link % is can''t change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'records_export_link_fixed';
  END IF;

  IF NEW.email_sent_at IS DISTINCT FROM OLD.email_sent_at THEN
    -- Only from NULL to a moment: a change from NULL to NULL isn't a change,
    -- so any other change starts from a recorded email.
    IF OLD.email_sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'Records export link % was already emailed', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_emailed_once';
    END IF;
    NEW.email_sent_at := now();
  END IF;

  -- Nothing about the link's STATE changed (only the email was recorded):
  -- done, whether it is open or not.
  IF (NEW.used_at, NEW.replaced_at, NEW.dob_failures)
     IS NOT DISTINCT FROM
     (OLD.used_at, OLD.replaced_at, OLD.dob_failures) THEN
    RETURN NEW;
  END IF;

  IF OLD.used_at IS NOT NULL OR OLD.replaced_at IS NOT NULL
     OR OLD.dob_failures >= 5 THEN
    RAISE EXCEPTION 'Records export link % is closed', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'records_export_link_closed';
  END IF;

  IF NEW.dob_failures IS DISTINCT FROM OLD.dob_failures THEN
    IF NEW.dob_failures <> OLD.dob_failures + 1
       OR OLD.token_hash IS DISTINCT FROM link_token THEN
      RAISE EXCEPTION 'A wrong date of birth adds one to records export link %, through the link', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_failure_counted';
    END IF;
  END IF;

  IF NEW.used_at IS NOT NULL THEN
    IF OLD.token_hash IS DISTINCT FROM link_token THEN
      RAISE EXCEPTION 'Records export link % is used only with its link', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_used_by_link';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'Records export link % has expired', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_not_expired';
    END IF;
    NEW.used_at := now();
  END IF;

  IF NEW.replaced_at IS NOT NULL THEN
    IF NOT rls_is_admin() THEN
      RAISE EXCEPTION 'Records export link % is replaced only by an admin', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'records_export_link_replaced_by_admin';
    END IF;
    NEW.replaced_at := now();
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER records_export_link_guard
  BEFORE INSERT OR UPDATE ON records_export_links
  FOR EACH ROW EXECUTE FUNCTION guard_records_export_link();