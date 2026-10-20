CREATE TABLE "program_alert_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"missed_since" date,
	"inactive_since" date,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_alert_reviews_some_fact" CHECK ("program_alert_reviews"."missed_since" IS NOT NULL OR "program_alert_reviews"."inactive_since" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "program_alert_reviews" ADD CONSTRAINT "program_alert_reviews_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_alert_reviews" ADD CONSTRAINT "program_alert_reviews_program_fk" FOREIGN KEY ("assigned_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_alert_reviews_latest_idx" ON "program_alert_reviews" USING btree ("practitioner_id","assigned_program_id","reviewed_at");