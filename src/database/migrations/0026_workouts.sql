CREATE TABLE "program_workouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"name" varchar(100),
	"sort_order" integer NOT NULL,
	CONSTRAINT "program_workouts_id_assigned_program_id_unique" UNIQUE("id","assigned_program_id"),
	CONSTRAINT "program_workouts_name_not_blank" CHECK ("program_workouts"."name" IS NULL OR length(btrim("program_workouts"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "template_workouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"name" varchar(100),
	"sort_order" integer NOT NULL,
	CONSTRAINT "template_workouts_id_template_id_unique" UNIQUE("id","template_id"),
	CONSTRAINT "template_workouts_name_not_blank" CHECK ("template_workouts"."name" IS NULL OR length(btrim("template_workouts"."name")) > 0)
);
--> statement-breakpoint
-- EDITED BY HAND after generation (same reason as 0024's local_date):
-- drizzle-kit wrote the three workout_id columns as "ADD COLUMN ... NOT NULL",
-- which fails on any table that already has rows. Instead: add them as
-- nullable here, fill them below (after the workout tables' own foreign keys
-- and indexes), then make them required — and only THEN add the composite
-- foreign keys, which check every existing row when they're created.
ALTER TABLE "assigned_program_exercises" ADD COLUMN "workout_id" integer;--> statement-breakpoint
ALTER TABLE "template_exercises" ADD COLUMN "workout_id" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workout_id" integer;--> statement-breakpoint
ALTER TABLE "program_workouts" ADD CONSTRAINT "program_workouts_assigned_program_id_assigned_programs_id_fk" FOREIGN KEY ("assigned_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_workouts" ADD CONSTRAINT "template_workouts_template_id_program_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."program_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_workouts_assigned_program_id_idx" ON "program_workouts" USING btree ("assigned_program_id");--> statement-breakpoint
CREATE INDEX "template_workouts_template_id_idx" ON "template_workouts" USING btree ("template_id");--> statement-breakpoint
-- EDITED BY HAND: the backfill. Every existing template and program gets ONE
-- workout (no name, position 0) holding all of its exercises — exactly how
-- they behaved before workouts existed. Templates and programs with no
-- exercises get one too: every template and program always has at least one
-- workout (the API never deletes the last), so an exercise added later has
-- somewhere to go. Every existing session did that one workout.
INSERT INTO "template_workouts" ("template_id", "sort_order")
  SELECT "id", 0 FROM "program_templates";--> statement-breakpoint
UPDATE "template_exercises" te SET "workout_id" = tw."id"
  FROM "template_workouts" tw WHERE tw."template_id" = te."template_id";--> statement-breakpoint
INSERT INTO "program_workouts" ("assigned_program_id", "sort_order")
  SELECT "id", 0 FROM "assigned_programs";--> statement-breakpoint
UPDATE "assigned_program_exercises" ape SET "workout_id" = pw."id"
  FROM "program_workouts" pw WHERE pw."assigned_program_id" = ape."assigned_program_id";--> statement-breakpoint
UPDATE "sessions" s SET "workout_id" = pw."id"
  FROM "program_workouts" pw WHERE pw."assigned_program_id" = s."assigned_program_id";--> statement-breakpoint
ALTER TABLE "template_exercises" ALTER COLUMN "workout_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ALTER COLUMN "workout_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "workout_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD CONSTRAINT "assigned_program_exercises_workout_fk" FOREIGN KEY ("workout_id","assigned_program_id") REFERENCES "public"."program_workouts"("id","assigned_program_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_exercises" ADD CONSTRAINT "template_exercises_workout_fk" FOREIGN KEY ("workout_id","template_id") REFERENCES "public"."template_workouts"("id","template_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workout_fk" FOREIGN KEY ("workout_id","assigned_program_id") REFERENCES "public"."program_workouts"("id","assigned_program_id") ON DELETE no action ON UPDATE no action;