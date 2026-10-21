-- Generated (Phase 6 — the audit review, step 2, 2026-10-21): an index for
-- "every entry about patient X, newest first". target_user_id is a foreign
-- key, and Postgres never indexes a foreign key by itself — until now that
-- filter read the whole table, and step 2 adds an entry per patient for
-- every read of their programs, sessions and alerts. (target_user_id,
-- created_at): one ordered index scan answers the filter and the order.
-- A plain CREATE INDEX locks the table against writes while it builds —
-- instant on a capstone's table; on a large live one, CONCURRENTLY (which
-- can't run inside a migration's transaction) would be the way.
CREATE INDEX "audit_logs_target_user_id_created_at_idx" ON "audit_logs" USING btree ("target_user_id","created_at");