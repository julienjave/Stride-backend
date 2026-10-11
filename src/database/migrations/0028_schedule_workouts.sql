ALTER TYPE "public"."schedule_type" ADD VALUE 'paused';--> statement-breakpoint
CREATE TABLE "program_schedule_days" (
	"schedule_id" integer NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"schedule_type" "schedule_type" DEFAULT 'weekdays' NOT NULL,
	"weekday" smallint NOT NULL,
	"workout_id" integer NOT NULL,
	CONSTRAINT "program_schedule_days_pk" PRIMARY KEY("schedule_id","weekday"),
	CONSTRAINT "program_schedule_days_weekday_range" CHECK ("program_schedule_days"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "program_schedule_days_only_weekdays" CHECK ("program_schedule_days"."schedule_type" = 'weekdays')
);
--> statement-breakpoint
CREATE TABLE "program_schedule_rotation" (
	"schedule_id" integer NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"schedule_type" "schedule_type" DEFAULT 'times_per_week' NOT NULL,
	"position" smallint NOT NULL,
	"workout_id" integer NOT NULL,
	CONSTRAINT "program_schedule_rotation_pk" PRIMARY KEY("schedule_id","position"),
	CONSTRAINT "program_schedule_rotation_position_range" CHECK ("program_schedule_rotation"."position" >= 0),
	CONSTRAINT "program_schedule_rotation_only_times_per_week" CHECK ("program_schedule_rotation"."schedule_type" = 'times_per_week')
);
--> statement-breakpoint
ALTER TABLE "program_schedules" DROP CONSTRAINT "program_schedules_fields_match_type";--> statement-breakpoint
ALTER TABLE "assigned_programs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
-- EDITED BY HAND after generation: a program set to 'on_hold' has no value in
-- the new type, so the cast below would fail on it. While the column is
-- plain text, those programs become 'active' — "on hold" is now a PAUSED
-- schedule version (decided 2026-10-10), and an old on_hold had no date to
-- pause from. (For the person's data: the seed never creates one.)
UPDATE "assigned_programs" SET "status" = 'active' WHERE "status" = 'on_hold';--> statement-breakpoint
ALTER TABLE "assigned_programs" ALTER COLUMN "status" SET DEFAULT 'active'::text;--> statement-breakpoint
DROP TYPE "public"."program_status";--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
ALTER TABLE "assigned_programs" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."program_status";--> statement-breakpoint
ALTER TABLE "assigned_programs" ALTER COLUMN "status" SET DATA TYPE "public"."program_status" USING "status"::"public"."program_status";--> statement-breakpoint
-- EDITED BY HAND: the order. The children's foreign keys point at
-- (id, assigned_program_id, type), so that UNIQUE constraint must exist
-- first (drizzle-kit wrote it last).
ALTER TABLE "program_schedules" ADD CONSTRAINT "program_schedules_id_program_type_unique" UNIQUE("id","assigned_program_id","type");--> statement-breakpoint
-- EDITED BY HAND: the backfill, before `weekdays` is dropped (drizzle-kit
-- drops it without copying it anywhere). Every existing version keeps its
-- meaning with the program's FIRST workout (the lowest position — before
-- step 2b-ii, every program had exactly one workout's worth of schedule):
--   - each weekday of a 'weekdays' version becomes a row (unnest turns the
--     array into one row per element);
--   - each 'times_per_week' version gets a one-position rotation.
-- DISTINCT ON keeps one workout per program: the first by position (then
-- by id, if two shared a position).
INSERT INTO "program_schedule_days" ("schedule_id", "assigned_program_id", "weekday", "workout_id")
  SELECT ps."id", ps."assigned_program_id", d."weekday", fw."id"
  FROM "program_schedules" ps
  CROSS JOIN LATERAL unnest(ps."weekdays") AS d("weekday")
  JOIN (
    SELECT DISTINCT ON ("assigned_program_id") "assigned_program_id", "id"
    FROM "program_workouts"
    ORDER BY "assigned_program_id", "sort_order", "id"
  ) fw ON fw."assigned_program_id" = ps."assigned_program_id"
  WHERE ps."type" = 'weekdays';--> statement-breakpoint
INSERT INTO "program_schedule_rotation" ("schedule_id", "assigned_program_id", "position", "workout_id")
  SELECT ps."id", ps."assigned_program_id", 0, fw."id"
  FROM "program_schedules" ps
  JOIN (
    SELECT DISTINCT ON ("assigned_program_id") "assigned_program_id", "id"
    FROM "program_workouts"
    ORDER BY "assigned_program_id", "sort_order", "id"
  ) fw ON fw."assigned_program_id" = ps."assigned_program_id"
  WHERE ps."type" = 'times_per_week';--> statement-breakpoint
ALTER TABLE "program_schedule_days" ADD CONSTRAINT "program_schedule_days_version_fk" FOREIGN KEY ("schedule_id","assigned_program_id","schedule_type") REFERENCES "public"."program_schedules"("id","assigned_program_id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_days" ADD CONSTRAINT "program_schedule_days_workout_fk" FOREIGN KEY ("workout_id","assigned_program_id") REFERENCES "public"."program_workouts"("id","assigned_program_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_rotation" ADD CONSTRAINT "program_schedule_rotation_version_fk" FOREIGN KEY ("schedule_id","assigned_program_id","schedule_type") REFERENCES "public"."program_schedules"("id","assigned_program_id","type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_rotation" ADD CONSTRAINT "program_schedule_rotation_workout_fk" FOREIGN KEY ("workout_id","assigned_program_id") REFERENCES "public"."program_workouts"("id","assigned_program_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_schedule_days_workout_id_idx" ON "program_schedule_days" USING btree ("workout_id");--> statement-breakpoint
CREATE INDEX "program_schedule_rotation_workout_id_idx" ON "program_schedule_rotation" USING btree ("workout_id");--> statement-breakpoint
-- Dropping the column also drops the CHECK that used it
-- (program_schedules_weekdays_valid, from 0025); the function it called,
-- is_iso_weekday_set(), is dropped by 0029.
ALTER TABLE "program_schedules" DROP COLUMN "weekdays";--> statement-breakpoint
ALTER TABLE "program_schedules" ADD CONSTRAINT "program_schedules_fields_match_type" CHECK (("program_schedules"."type" = 'times_per_week') = ("program_schedules"."times_per_week" IS NOT NULL));