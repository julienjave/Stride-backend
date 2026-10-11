ALTER TABLE "assigned_programs" ADD COLUMN "based_on_program_id" integer;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD COLUMN "allow_swaps" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "counts_for" date;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_based_on_program_id_assigned_programs_id_fk" FOREIGN KEY ("based_on_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_not_based_on_itself" CHECK ("assigned_programs"."based_on_program_id" IS NULL OR "assigned_programs"."based_on_program_id" <> "assigned_programs"."id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_counts_for_other_day" CHECK ("sessions"."counts_for" IS NULL OR "sessions"."counts_for" <> "sessions"."local_date");