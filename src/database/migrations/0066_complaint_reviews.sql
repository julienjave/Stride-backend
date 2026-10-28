CREATE TABLE "complaint_review_notice_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"complaint_review_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_review_reasons" (
	"review_id" integer PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"case_reference" varchar(100),
	CONSTRAINT "complaint_review_reasons_reason_not_blank" CHECK (btrim("complaint_review_reasons"."reason") <> '' AND char_length("complaint_review_reasons"."reason") <= 1000),
	CONSTRAINT "complaint_review_reasons_case_reference_not_blank" CHECK ("complaint_review_reasons"."case_reference" IS NULL OR btrim("complaint_review_reasons"."case_reference") <> '')
);
--> statement-breakpoint
CREATE TABLE "complaint_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"opened_by" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" integer,
	CONSTRAINT "complaint_reviews_ended_together" CHECK (("complaint_reviews"."ended_at" IS NULL) = ("complaint_reviews"."ended_by" IS NULL)),
	CONSTRAINT "complaint_reviews_expires_after_opening" CHECK ("complaint_reviews"."expires_at" > "complaint_reviews"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "complaint_review_notice_reviews" ADD CONSTRAINT "complaint_review_notice_reviews_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_review_notice_reviews" ADD CONSTRAINT "complaint_review_notice_reviews_review_fk" FOREIGN KEY ("complaint_review_id") REFERENCES "public"."complaint_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_review_reasons" ADD CONSTRAINT "complaint_review_reasons_review_id_complaint_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."complaint_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_reviews" ADD CONSTRAINT "complaint_reviews_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_reviews" ADD CONSTRAINT "complaint_reviews_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_reviews" ADD CONSTRAINT "complaint_reviews_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "complaint_review_notice_reviews_one_per_practitioner" ON "complaint_review_notice_reviews" USING btree ("complaint_review_id","practitioner_id");--> statement-breakpoint
CREATE INDEX "complaint_reviews_patient_id_idx" ON "complaint_reviews" USING btree ("patient_id");