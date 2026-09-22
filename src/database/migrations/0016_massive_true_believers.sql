ALTER TABLE "assigned_program_exercises" ADD COLUMN "name" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "primary_muscles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "secondary_muscles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "equipment" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD COLUMN "instructions" text[] NOT NULL;