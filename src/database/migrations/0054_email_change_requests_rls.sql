-- Custom SQL migration file, put your code below! --
--
-- Row-level security and the guard trigger for email_change_requests (table
-- created by 0053; "Change email", decisions §12).
--
-- Who may touch a request:
--   - its OWNER, signed in (user_id = the session's user): asking for a
--     change, reading the pending one, cancelling it from the profile;
--   - the holder of the CONFIRM token (the link emailed to the NEW
--     address): confirming;
--   - the holder of the CANCEL token (the link emailed to the OLD address):
--     cancelling.
-- No admin, no practitioner: an email change is self-service only (the
-- person's choice — a staff path would be an account-takeover path). The
-- audit log is where admins see what happened.
--
-- THE TOKEN BRANCHES work like the invitation's (0021): the confirm and
-- cancel pages are used without a session (the link may be opened on any
-- device), so the app proves it holds a token by putting the token's HASH in
-- a transaction-local setting (withEmailChangeTokenContext, rls-context.ts),
-- and the policies let that transaction see exactly the one row with that
-- hash. TWO settings, one per link, so each token reaches only its own
-- column: the old inbox's link can never be taken for the new one's.
-- On a pooled connection a setting a previous request used reads '' — no
-- token hash is '' (64 hex characters), so it matches nothing.

ALTER TABLE email_change_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_change_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY email_change_requests_select ON email_change_requests
  FOR SELECT
  USING (
    user_id = rls_current_user_id()
    OR token_hash = current_setting('app.email_change_token_hash', true)
    OR cancel_token_hash = current_setting('app.email_change_cancel_token_hash', true)
  );--> statement-breakpoint

-- Insert: only for yourself. Not a token holder: a link can act on its
-- request, never create one.
CREATE POLICY email_change_requests_insert ON email_change_requests
  FOR INSERT
  WITH CHECK (user_id = rls_current_user_id());--> statement-breakpoint

-- Update = closing a request (confirming or cancelling it). WHICH changes are
-- allowed, and by which of the three, is the trigger's job below: a policy
-- sees rows, not the difference between OLD and NEW.
CREATE POLICY email_change_requests_update ON email_change_requests
  FOR UPDATE
  USING (
    user_id = rls_current_user_id()
    OR token_hash = current_setting('app.email_change_token_hash', true)
    OR cancel_token_hash = current_setting('app.email_change_cancel_token_hash', true)
  )
  WITH CHECK (
    user_id = rls_current_user_id()
    OR token_hash = current_setting('app.email_change_token_hash', true)
    OR cancel_token_hash = current_setting('app.email_change_cancel_token_hash', true)
  );--> statement-breakpoint

-- Delete: deliberately NO policy — a request is closed, never erased.

-- === The guard ==============================================================
--
-- What the database guarantees, whatever writes the row (the service checks
-- the same things first, under the row's lock, and answers with its own
-- words; reaching one of these refusals means a bug — a 500, on purpose):
--   - a new request is OPEN, and its created_at is the database's moment;
--   - a closed request (confirmed or cancelled) is FINAL;
--   - what a request IS never changes: its account, address, tokens and
--     dates;
--   - CONFIRMING needs the confirm link (the new inbox proved), before the
--     expiry by the database's clock; its moment is the database's;
--   - cancelling "by the email link" needs the cancel link; any
--     cancellation's moment is the database's.
-- The tables' owner passes untouched (the seed's reset, tests planting
-- rows) — the same exemption as 0031, 0033, 0048, 0050.
--
-- Each refusal is a check_violation (23514) carrying a constraint NAME, like
-- the closed-program guard: tests (and logs) can tell them apart.
CREATE FUNCTION guard_email_change_request() RETURNS trigger
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
    IF NEW.confirmed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new email change request must be open'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'email_change_request_starts_open';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.confirmed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Email change request % is closed', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'email_change_request_closed';
  END IF;

  -- A row compared with a row: IS DISTINCT FROM treats two NULLs as equal
  -- (none of these columns is nullable, but the habit costs nothing).
  IF (NEW.id, NEW.user_id, NEW.new_email, NEW.token_hash,
      NEW.cancel_token_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.new_email, OLD.token_hash,
      OLD.cancel_token_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'What email change request % asks for can''t change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'email_change_request_fixed';
  END IF;

  IF NEW.confirmed_at IS NOT NULL THEN
    IF OLD.token_hash IS DISTINCT FROM
       current_setting('app.email_change_token_hash', true) THEN
      RAISE EXCEPTION 'Email change request % is confirmed only with its link', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'email_change_request_confirmed_by_link';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'Email change request % has expired', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'email_change_request_not_expired';
    END IF;
    NEW.confirmed_at := now();
  END IF;

  IF NEW.cancelled_at IS NOT NULL THEN
    IF NEW.cancel_reason = 'cancelled_by_email_link'
       AND OLD.cancel_token_hash IS DISTINCT FROM
           current_setting('app.email_change_cancel_token_hash', true) THEN
      RAISE EXCEPTION 'Email change request % is cancelled by link only with its link', OLD.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'email_change_request_cancelled_by_link';
    END IF;
    NEW.cancelled_at := now();
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER email_change_request_guard
  BEFORE INSERT OR UPDATE ON email_change_requests
  FOR EACH ROW EXECUTE FUNCTION guard_email_change_request();