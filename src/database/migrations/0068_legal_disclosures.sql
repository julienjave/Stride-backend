CREATE TYPE "public"."legal_basis" AS ENUM('court_order', 'subpoena', 'required_by_law', 'law_enforcement', 'health_oversight', 'coroner', 'other');--> statement-breakpoint
CREATE TABLE "legal_disclosure_details" (
	"disclosure_id" integer PRIMARY KEY NOT NULL,
	"legal_basis" "legal_basis" NOT NULL,
	"basis_explanation" text,
	"includes_medical_file" boolean NOT NULL,
	"includes_programs" boolean NOT NULL,
	"includes_sessions" boolean NOT NULL,
	"includes_messages" boolean NOT NULL,
	"period_from" date,
	"period_to" date,
	CONSTRAINT "legal_disclosure_details_explanation_with_other" CHECK (("legal_disclosure_details"."legal_basis" = 'other') = ("legal_disclosure_details"."basis_explanation" IS NOT NULL)),
	CONSTRAINT "legal_disclosure_details_explanation_not_blank" CHECK ("legal_disclosure_details"."basis_explanation" IS NULL OR (btrim("legal_disclosure_details"."basis_explanation") <> '' AND char_length("legal_disclosure_details"."basis_explanation") <= 1000)),
	CONSTRAINT "legal_disclosure_details_some_part" CHECK ("legal_disclosure_details"."includes_medical_file" OR "legal_disclosure_details"."includes_programs" OR "legal_disclosure_details"."includes_sessions" OR "legal_disclosure_details"."includes_messages"),
	CONSTRAINT "legal_disclosure_details_period_in_order" CHECK ("legal_disclosure_details"."period_from" IS NULL OR "legal_disclosure_details"."period_to" IS NULL OR "legal_disclosure_details"."period_from" <= "legal_disclosure_details"."period_to")
);
--> statement-breakpoint
CREATE TABLE "legal_disclosure_notice_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"disclosure_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_disclosure_orders" (
	"disclosure_id" integer PRIMARY KEY NOT NULL,
	"order_reference" varchar(100),
	"received_on" date NOT NULL,
	"withholding_statement" text,
	CONSTRAINT "legal_disclosure_orders_reference_not_blank" CHECK ("legal_disclosure_orders"."order_reference" IS NULL OR btrim("legal_disclosure_orders"."order_reference") <> ''),
	CONSTRAINT "legal_disclosure_orders_statement_not_blank" CHECK ("legal_disclosure_orders"."withholding_statement" IS NULL OR (btrim("legal_disclosure_orders"."withholding_statement") <> '' AND char_length("legal_disclosure_orders"."withholding_statement") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "legal_disclosures" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"made_by" integer NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_name" varchar(200) NOT NULL,
	"recipient_organisation" varchar(200),
	"withheld_until" timestamp with time zone,
	CONSTRAINT "legal_disclosures_recipient_name_not_blank" CHECK (btrim("legal_disclosures"."recipient_name") <> ''),
	CONSTRAINT "legal_disclosures_recipient_organisation_not_blank" CHECK ("legal_disclosures"."recipient_organisation" IS NULL OR btrim("legal_disclosures"."recipient_organisation") <> '')
);
--> statement-breakpoint
ALTER TABLE "legal_disclosure_details" ADD CONSTRAINT "legal_disclosure_details_disclosure_id_legal_disclosures_id_fk" FOREIGN KEY ("disclosure_id") REFERENCES "public"."legal_disclosures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_disclosure_notice_reviews" ADD CONSTRAINT "legal_disclosure_notice_reviews_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_disclosure_notice_reviews" ADD CONSTRAINT "legal_disclosure_notice_reviews_disclosure_fk" FOREIGN KEY ("disclosure_id") REFERENCES "public"."legal_disclosures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_disclosure_orders" ADD CONSTRAINT "legal_disclosure_orders_disclosure_id_legal_disclosures_id_fk" FOREIGN KEY ("disclosure_id") REFERENCES "public"."legal_disclosures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_disclosures" ADD CONSTRAINT "legal_disclosures_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_disclosures" ADD CONSTRAINT "legal_disclosures_made_by_users_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_disclosure_notice_reviews_one_per_practitioner" ON "legal_disclosure_notice_reviews" USING btree ("disclosure_id","practitioner_id");--> statement-breakpoint
CREATE INDEX "legal_disclosures_patient_id_idx" ON "legal_disclosures" USING btree ("patient_id");