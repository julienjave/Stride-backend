ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT
  USING (current_setting('app.current_role', true) = 'admin');--> statement-breakpoint
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT
  WITH CHECK (true);
