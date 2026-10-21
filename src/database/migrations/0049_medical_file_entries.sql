-- Hand-edited (Phase 6 — medical files, decided with the person 2026-10-20):
-- a medical file entry becomes a SOAP note (an entry type and four text
-- sections) that can be AMENDED by a later entry, instead of a free-form
-- jsonb. drizzle-kit generated the statements; three things are changed:
--   1. entry_type is added NULLABLE, filled, then made NOT NULL — generated
--      as "ADD COLUMN … NOT NULL" with no default, which fails on a table
--      that already has rows (the 0032 pattern);
--   2. the existing rows' clinical_data is carried into the new columns
--      BEFORE the column is dropped (below) — dropping first would lose it;
--   3. the UNIQUE (id, patient_id) is created BEFORE the foreign key that
--      points at it — generated the other way round, which Postgres refuses
--      ("there is no unique constraint matching given keys").
CREATE TYPE "public"."medical_file_entry_type" AS ENUM('initial_assessment', 'progress_note', 'discharge_summary');--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "entry_type" "medical_file_entry_type";--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "subjective" text;--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "objective" text;--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "assessment" text;--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "amends_id" integer;--> statement-breakpoint
ALTER TABLE "medical_files" ADD COLUMN "amendment_reason" text;--> statement-breakpoint
-- The existing rows (made through the old API, which took any JSON object)
-- become progress notes whose Subjective section holds what they said:
--   - { "note": "…" } and nothing else — the only shape the old tests and
--     manual checks wrote — gives that text;
--   - any other non-empty object gives its JSON text, as written: nothing is
--     interpreted or lost;
--   - an empty object, or a note that is only white space, held nothing — a
--     visible placeholder (an entry must have content now, below).
-- Cut to the section's 10,000 characters (the old limit was 50 KB of JSON).
-- Done once, here, as the table's owner — after 0050 nobody can edit an
-- entry.
UPDATE "medical_files" SET
  "entry_type" = 'progress_note',
  "subjective" = CASE
    WHEN content ~ '\S' THEN left(content, 10000)
    ELSE '(no content recorded)'
  END
FROM (
  SELECT "id" AS row_id,
    CASE
      WHEN "clinical_data" ? 'note'
        AND jsonb_typeof("clinical_data" -> 'note') = 'string'
        AND "clinical_data" - 'note' = '{}'::jsonb
        THEN "clinical_data" ->> 'note'
      WHEN "clinical_data" = '{}'::jsonb THEN ''
      ELSE "clinical_data"::text
    END AS content
  FROM "medical_files"
) AS old
WHERE "medical_files"."id" = old.row_id;--> statement-breakpoint
ALTER TABLE "medical_files" ALTER COLUMN "entry_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medical_files" DROP COLUMN "clinical_data";--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_id_patient_unique" UNIQUE("id","patient_id");--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_amends_same_patient_fk" FOREIGN KEY ("amends_id","patient_id") REFERENCES "public"."medical_files"("id","patient_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_one_amendment_per_entry" UNIQUE("amends_id");--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_not_self_amending" CHECK ("medical_files"."amends_id" IS NULL OR "medical_files"."amends_id" <> "medical_files"."id");--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_has_content" CHECK (num_nonnulls("medical_files"."subjective", "medical_files"."objective", "medical_files"."assessment", "medical_files"."plan") >= 1);--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_sections_valid" CHECK ((subjective IS NULL OR (subjective ~ '\S' AND char_length(subjective) <= 10000)) AND (objective IS NULL OR (objective ~ '\S' AND char_length(objective) <= 10000)) AND (assessment IS NULL OR (assessment ~ '\S' AND char_length(assessment) <= 10000)) AND (plan IS NULL OR (plan ~ '\S' AND char_length(plan) <= 10000)));--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_amendment_reason_valid" CHECK (("medical_files"."amends_id" IS NULL) = ("medical_files"."amendment_reason" IS NULL) AND ("medical_files"."amendment_reason" IS NULL OR ("medical_files"."amendment_reason" ~ '\S' AND char_length("medical_files"."amendment_reason") <= 500)));