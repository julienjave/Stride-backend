-- Custom SQL migration file, put your code below! --
--
-- Row-level security and the guard trigger for mfa_recovery_codes (table
-- created by 0057; MFA enrolment, pass 2 — decisions §14).
--
-- Who may touch a code:
--   - its OWNER, signed in (user_id = the session's user): creating codes
--     (turning MFA on, asking for new ones), using one (marking it used),
--     deleting them (new ones replace them; turning MFA off);
--   - an ADMIN, to DELETE them (the admin reset — the account's codes die
--     with its second factor). An admin reads them for that delete only (a
--     DELETE with a WHERE reads the rows it removes, so the SELECT policy
--     applies too); what they would see is keyed hashes, useless without
--     the server's key.
-- Nobody else; no practitioner path.
--
-- Signing in with a recovery code happens BEFORE the session is signed in:
-- MfaService.verifySignIn acts as the pending account (its id and role —
-- the same context it uses to record a TOTP code), so the owner branch
-- covers it.

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY mfa_recovery_codes_select ON mfa_recovery_codes
  FOR SELECT
  USING (user_id = rls_current_user_id() OR rls_is_admin());--> statement-breakpoint

-- Insert: only your own. Not an admin: nobody creates codes for someone else
-- (they would know them).
CREATE POLICY mfa_recovery_codes_insert ON mfa_recovery_codes
  FOR INSERT
  WITH CHECK (user_id = rls_current_user_id());--> statement-breakpoint

-- Update = marking a code used, by its owner. WHICH change is allowed is the
-- trigger's job below (a policy sees rows, not OLD versus NEW).
CREATE POLICY mfa_recovery_codes_update ON mfa_recovery_codes
  FOR UPDATE
  USING (user_id = rls_current_user_id())
  WITH CHECK (user_id = rls_current_user_id());--> statement-breakpoint

CREATE POLICY mfa_recovery_codes_delete ON mfa_recovery_codes
  FOR DELETE
  USING (user_id = rls_current_user_id() OR rls_is_admin());--> statement-breakpoint

-- === The guard ==============================================================
--
-- What the database guarantees, whatever writes the row (the service never
-- asks for anything else — reaching one of these refusals means a bug, a
-- 500 on purpose):
--   - a new code is UNUSED, and its created_at is the database's moment;
--   - a code is used ONCE: used_at goes from null to the database's moment,
--     and never changes again (a used code can't be "un-used");
--   - what a code IS never changes: its account, hash and creation moment.
-- The tables' owner passes untouched (the seed's reset, tests planting rows)
-- — the same exemption as 0031, 0033, 0048, 0050, 0054.
--
-- Each refusal is a check_violation (23514) carrying a constraint NAME, like
-- the other guards: tests (and logs) can tell them apart.
CREATE FUNCTION guard_mfa_recovery_code() RETURNS trigger
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
    IF NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new recovery code must be unused'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'mfa_recovery_code_starts_unused';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'Recovery code % is already used', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mfa_recovery_code_used_once';
  END IF;

  -- A row compared with a row: IS DISTINCT FROM treats two NULLs as equal.
  IF (NEW.id, NEW.user_id, NEW.code_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.code_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Recovery code % can''t change', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mfa_recovery_code_fixed';
  END IF;

  -- The only change left: marking it used — at the database's moment.
  IF NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'Recovery code % can only be marked used', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mfa_recovery_code_only_marked_used';
  END IF;
  NEW.used_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER mfa_recovery_code_guard
  BEFORE INSERT OR UPDATE ON mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION guard_mfa_recovery_code();