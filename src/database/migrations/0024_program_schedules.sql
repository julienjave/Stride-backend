CREATE TYPE "public"."schedule_type" AS ENUM('weekdays', 'times_per_week');--> statement-breakpoint
CREATE TABLE "program_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"type" "schedule_type" NOT NULL,
	"weekdays" smallint[],
	"times_per_week" smallint,
	"effective_from" date NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_schedules_program_effective_from_unique" UNIQUE("assigned_program_id","effective_from"),
	CONSTRAINT "program_schedules_fields_match_type" CHECK (("program_schedules"."type" = 'weekdays' AND "program_schedules"."weekdays" IS NOT NULL AND "program_schedules"."times_per_week" IS NULL)
        OR ("program_schedules"."type" = 'times_per_week' AND "program_schedules"."times_per_week" IS NOT NULL AND "program_schedules"."weekdays" IS NULL)),
	CONSTRAINT "program_schedules_times_per_week_range" CHECK ("program_schedules"."times_per_week" IS NULL OR "program_schedules"."times_per_week" BETWEEN 1 AND 7)
);
--> statement-breakpoint
-- EDITED BY HAND after generation: drizzle-kit wrote this column as a single
-- "ADD COLUMN ... NOT NULL", which fails on any database that already has
-- sessions (every existing row would get NULL). Three steps instead: add it
-- as nullable, fill it, then make it required. Existing sessions get the UTC
-- day of their timestamp — the patient's own day was never recorded, and for
-- development data this approximation is fine.
ALTER TABLE "sessions" ADD COLUMN "local_date" date;--> statement-breakpoint
UPDATE "sessions" SET "local_date" = ("scheduled_date" AT TIME ZONE 'UTC')::date;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "local_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "program_schedules" ADD CONSTRAINT "program_schedules_assigned_program_id_assigned_programs_id_fk" FOREIGN KEY ("assigned_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedules" ADD CONSTRAINT "program_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_assigned_program_id_local_date_idx" ON "sessions" USING btree ("assigned_program_id","local_date");--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_ends_after_start" CHECK ("assigned_programs"."end_date" IS NULL OR "assigned_programs"."end_date" >= "assigned_programs"."start_date");