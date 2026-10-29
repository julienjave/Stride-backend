-- Custom SQL migration (storage clean-up, decided 2026-10-29): archiving a
-- program — the app's "delete", only for a program with NO session — now
-- drops its exercises' OWN photos too. A deleted program is never shown again,
-- and a photo of the patient kept without a use is data held for nothing.
-- AssignedProgramsService (archive(), and close() when a cancel archives)
-- empties media_urls in the archiving transaction, lists the keys in the
-- ASSIGNED_PROGRAM_ARCHIVED entry, and deletes the files after the commit.
--
-- The closed-program guard (0031) refuses EVERY change to a closed program's
-- children, and must keep doing so. Emptying the photos can't simply happen
-- "before the program is closed": a COMPLETED program with no session may
-- still be archived, and its exercises are already guarded then. So the
-- guard gets ONE exception, as narrow as the change it allows:
--   - the table is assigned_program_exercises, the operation an UPDATE;
--   - the row's program is ARCHIVED (not merely completed or cancelled —
--     a cancelled program with sessions is part of the record, and keeps
--     its photos);
--   - media_urls becomes empty, and NOTHING ELSE about the row changes:
--     the whole row as JSON without media_urls, before and after, is equal
--     (the same comparison 0031 uses for archiving the program row itself).
-- The service archives the program FIRST, then empties the photos, in the
-- same transaction — the trigger reads that transaction's own change.
--
-- The rest of the function is 0031's, unchanged. CREATE OR REPLACE keeps the
-- four triggers that call it; nothing else needs touching.
--
-- Why to_jsonb(NEW) -> 'media_urls' and not NEW.media_urls: this one
-- function serves four tables, and three of them have no media_urls column.
-- PL/pgSQL looks a record's field up when the expression runs, and doesn't
-- promise to skip the rest of an AND once its first part is false — so a
-- plain NEW.media_urls could fail on program_workouts. Through to_jsonb, a
-- row without the column gives NULL, and the test is simply not true.
--
-- The outer IF (this table, an UPDATE) therefore changes no outcome: on the
-- other tables the JSON field is NULL, and on an INSERT or a DELETE the
-- missing OLD / NEW is NULL — the inner test is false either way (a
-- mutation removing the outer IF survives the tests, as it must). It stays
-- so the other tables' writes don't build two JSON copies of their row, and
-- so a reader sees at once whom the exception is for.

CREATE OR REPLACE FUNCTION guard_closed_program_child() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  program_ids integer[];
  closed_id integer;
BEGIN
  IF pg_has_role(
       current_user,
       (SELECT relowner FROM pg_class WHERE oid = TG_RELID),
       'MEMBER'
     ) THEN
    RETURN NULL;
  END IF;
  -- (0070) An ARCHIVED program's exercise may lose its own photos, and
  -- nothing else.
  IF TG_TABLE_NAME = 'assigned_program_exercises' AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) -> 'media_urls' = '[]'::jsonb
       AND (to_jsonb(NEW) - 'media_urls') = (to_jsonb(OLD) - 'media_urls')
       AND EXISTS (
         SELECT 1
           FROM assigned_programs ap
           WHERE ap.id = NEW.assigned_program_id
             AND ap.is_archived
       ) THEN
      RETURN NULL;
    END IF;
  END IF;
  -- The program(s) the row belongs to: before and after an UPDATE (the
  -- composite keys keep them equal today, but the rule doesn't rely on it).
  IF TG_OP = 'INSERT' THEN
    program_ids := ARRAY[NEW.assigned_program_id];
  ELSIF TG_OP = 'DELETE' THEN
    program_ids := ARRAY[OLD.assigned_program_id];
  ELSE
    program_ids := ARRAY[OLD.assigned_program_id, NEW.assigned_program_id];
  END IF;
  SELECT ap.id INTO closed_id
    FROM assigned_programs ap
    WHERE ap.id = ANY (program_ids)
      AND (ap.status <> 'active' OR ap.is_archived)
    LIMIT 1;
  IF closed_id IS NOT NULL THEN
    RAISE EXCEPTION 'Assigned program % is closed, so it can no longer change', closed_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assigned_program_closed',
            TABLE = TG_TABLE_NAME;
  END IF;
  -- An AFTER trigger's result is ignored.
  RETURN NULL;
END
$$;