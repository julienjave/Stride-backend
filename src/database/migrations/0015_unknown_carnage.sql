CREATE TYPE "public"."weight_unit" AS ENUM('kg', 'lbs');--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "weight" real;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "weight_unit" "weight_unit";--> statement-breakpoint
ALTER TABLE "template_exercises" ADD COLUMN "weight" real;--> statement-breakpoint
ALTER TABLE "template_exercises" ADD COLUMN "weight_unit" "weight_unit";