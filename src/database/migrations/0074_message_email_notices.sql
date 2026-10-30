ALTER TABLE "users" ADD COLUMN "message_email_notices" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "practitioner_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "patient_notified_at" timestamp with time zone;