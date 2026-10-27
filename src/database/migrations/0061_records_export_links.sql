CREATE TABLE "records_export_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"sent_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"email_sent_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"dob_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "records_export_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "records_export_links_used_or_replaced" CHECK ("records_export_links"."used_at" IS NULL OR "records_export_links"."replaced_at" IS NULL),
	CONSTRAINT "records_export_links_dob_failures_in_range" CHECK ("records_export_links"."dob_failures" BETWEEN 0 AND 5),
	CONSTRAINT "records_export_links_expires_after_creation" CHECK ("records_export_links"."expires_at" > "records_export_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "records_export_links" ADD CONSTRAINT "records_export_links_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records_export_links" ADD CONSTRAINT "records_export_links_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "records_export_links_one_open_per_patient" ON "records_export_links" USING btree ("patient_id") WHERE "records_export_links"."used_at" IS NULL AND "records_export_links"."replaced_at" IS NULL AND "records_export_links"."dob_failures" < 5;--> statement-breakpoint
CREATE INDEX "records_export_links_patient_id_idx" ON "records_export_links" USING btree ("patient_id");