CREATE TABLE "patient_merge_notice_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"merge_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_merges" (
	"id" serial PRIMARY KEY NOT NULL,
	"survivor_id" integer NOT NULL,
	"merged_id" integer NOT NULL,
	"merged_by" integer NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_merges_not_self" CHECK ("patient_merges"."survivor_id" <> "patient_merges"."merged_id")
);
--> statement-breakpoint
ALTER TABLE "patient_merge_notice_reviews" ADD CONSTRAINT "patient_merge_notice_reviews_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_notice_reviews" ADD CONSTRAINT "patient_merge_notice_reviews_merge_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."patient_merges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_survivor_id_users_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_merged_id_users_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_merged_by_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merge_notice_reviews_one_per_practitioner" ON "patient_merge_notice_reviews" USING btree ("merge_id","practitioner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merges_merged_once" ON "patient_merges" USING btree ("merged_id");--> statement-breakpoint
CREATE INDEX "patient_merges_survivor_idx" ON "patient_merges" USING btree ("survivor_id");