ALTER TABLE "clinics" ADD COLUMN "address_line1" varchar(255);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_line2" varchar(255);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_city" varchar(100);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_state" varchar(100);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_country" varchar(2);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_line1" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_line2" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_city" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_state" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address_country" varchar(2);--> statement-breakpoint
ALTER TABLE "clinics" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "address";