ALTER TABLE "users" ADD COLUMN "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address" varchar(500);--> statement-breakpoint
ALTER TABLE "patient_profiles" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "patient_profiles" DROP COLUMN "address";