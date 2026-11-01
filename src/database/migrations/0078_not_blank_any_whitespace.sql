ALTER TABLE "assigned_programs" DROP CONSTRAINT "assigned_programs_title_not_blank";--> statement-breakpoint
ALTER TABLE "program_templates" DROP CONSTRAINT "program_templates_title_not_blank";--> statement-breakpoint
ALTER TABLE "program_workouts" DROP CONSTRAINT "program_workouts_name_not_blank";--> statement-breakpoint
ALTER TABLE "template_workouts" DROP CONSTRAINT "template_workouts_name_not_blank";--> statement-breakpoint
ALTER TABLE "complaint_review_reasons" DROP CONSTRAINT "complaint_review_reasons_reason_not_blank";--> statement-breakpoint
ALTER TABLE "complaint_review_reasons" DROP CONSTRAINT "complaint_review_reasons_case_reference_not_blank";--> statement-breakpoint
ALTER TABLE "legal_disclosure_details" DROP CONSTRAINT "legal_disclosure_details_explanation_not_blank";--> statement-breakpoint
ALTER TABLE "legal_disclosure_orders" DROP CONSTRAINT "legal_disclosure_orders_reference_not_blank";--> statement-breakpoint
ALTER TABLE "legal_disclosure_orders" DROP CONSTRAINT "legal_disclosure_orders_statement_not_blank";--> statement-breakpoint
ALTER TABLE "legal_disclosures" DROP CONSTRAINT "legal_disclosures_recipient_name_not_blank";--> statement-breakpoint
ALTER TABLE "legal_disclosures" DROP CONSTRAINT "legal_disclosures_recipient_organisation_not_blank";--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_title_not_blank" CHECK ("assigned_programs"."title" ~ '\S');--> statement-breakpoint
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_title_not_blank" CHECK ("program_templates"."title" ~ '\S');--> statement-breakpoint
ALTER TABLE "program_workouts" ADD CONSTRAINT "program_workouts_name_not_blank" CHECK ("program_workouts"."name" IS NULL OR "program_workouts"."name" ~ '\S');--> statement-breakpoint
ALTER TABLE "template_workouts" ADD CONSTRAINT "template_workouts_name_not_blank" CHECK ("template_workouts"."name" IS NULL OR "template_workouts"."name" ~ '\S');--> statement-breakpoint
ALTER TABLE "complaint_review_reasons" ADD CONSTRAINT "complaint_review_reasons_reason_not_blank" CHECK ("complaint_review_reasons"."reason" ~ '\S' AND char_length("complaint_review_reasons"."reason") <= 1000);--> statement-breakpoint
ALTER TABLE "complaint_review_reasons" ADD CONSTRAINT "complaint_review_reasons_case_reference_not_blank" CHECK ("complaint_review_reasons"."case_reference" IS NULL OR "complaint_review_reasons"."case_reference" ~ '\S');--> statement-breakpoint
ALTER TABLE "legal_disclosure_details" ADD CONSTRAINT "legal_disclosure_details_explanation_not_blank" CHECK ("legal_disclosure_details"."basis_explanation" IS NULL OR ("legal_disclosure_details"."basis_explanation" ~ '\S' AND char_length("legal_disclosure_details"."basis_explanation") <= 1000));--> statement-breakpoint
ALTER TABLE "legal_disclosure_orders" ADD CONSTRAINT "legal_disclosure_orders_reference_not_blank" CHECK ("legal_disclosure_orders"."order_reference" IS NULL OR "legal_disclosure_orders"."order_reference" ~ '\S');--> statement-breakpoint
ALTER TABLE "legal_disclosure_orders" ADD CONSTRAINT "legal_disclosure_orders_statement_not_blank" CHECK ("legal_disclosure_orders"."withholding_statement" IS NULL OR ("legal_disclosure_orders"."withholding_statement" ~ '\S' AND char_length("legal_disclosure_orders"."withholding_statement") <= 2000));--> statement-breakpoint
ALTER TABLE "legal_disclosures" ADD CONSTRAINT "legal_disclosures_recipient_name_not_blank" CHECK ("legal_disclosures"."recipient_name" ~ '\S');--> statement-breakpoint
ALTER TABLE "legal_disclosures" ADD CONSTRAINT "legal_disclosures_recipient_organisation_not_blank" CHECK ("legal_disclosures"."recipient_organisation" IS NULL OR "legal_disclosures"."recipient_organisation" ~ '\S');