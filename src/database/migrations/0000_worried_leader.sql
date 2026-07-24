CREATE TYPE "public"."role" AS ENUM('admin', 'practitioner', 'patient');--> statement-breakpoint
CREATE TYPE "public"."exercise_source" AS ENUM('api', 'custom');--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('active', 'completed', 'on_hold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('pending', 'in_progress', 'completed', 'skipped');--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"website" varchar(255),
	"logo_path" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"position" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "patient_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"phone" varchar(50),
	"address" varchar(500),
	"date_of_birth" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practitioner_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"license_number" varchar(100) NOT NULL,
	"specialties" text[] DEFAULT '{}' NOT NULL,
	"bio" text,
	CONSTRAINT "practitioner_profiles_license_number_unique" UNIQUE("license_number")
);
--> statement-breakpoint
CREATE TABLE "user_clinics" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"clinic_id" integer NOT NULL,
	CONSTRAINT "user_clinics_user_clinic_unique" UNIQUE("user_id","clinic_id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"role" "role" NOT NULL,
	CONSTRAINT "user_roles_user_role_unique" UNIQUE("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"avatar_path" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "medical_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clinical_data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"practitioner_id" integer NOT NULL,
	"patient_id" integer NOT NULL,
	CONSTRAINT "conversations_practitioner_patient_unique" UNIQUE("practitioner_id","patient_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"message_body" text NOT NULL,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" varchar(255),
	"name" varchar(255) NOT NULL,
	"primary_muscles" text[] DEFAULT '{}' NOT NULL,
	"secondary_muscles" text[] DEFAULT '{}' NOT NULL,
	"equipment" text[] DEFAULT '{}' NOT NULL,
	"instructions" text[] NOT NULL,
	"media_urls" text[] DEFAULT '{}' NOT NULL,
	"source" "exercise_source" NOT NULL,
	"created_by" integer,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assigned_program_exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"exercise_id" integer NOT NULL,
	"sets" integer,
	"reps" integer,
	"duration_in_seconds" integer,
	"sort_order" integer NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "assigned_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"assigned_by" integer NOT NULL,
	"based_on_template_id" integer,
	"title" varchar(255) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" "program_status" DEFAULT 'active' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"practitioner_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"exercise_id" integer NOT NULL,
	"sets" integer,
	"reps" integer,
	"duration_in_seconds" integer,
	"sort_order" integer NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "session_exercises" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"assigned_program_exercise_id" integer NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"duration_actual_in_seconds" integer,
	"difficulty_rating" integer,
	"sort_order" integer NOT NULL,
	"feedback" text,
	CONSTRAINT "difficulty_rating_range" CHECK ("session_exercises"."difficulty_rating" IS NULL OR "session_exercises"."difficulty_rating" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"assigned_program_id" integer NOT NULL,
	"patient_id" integer NOT NULL,
	"scheduled_date" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"total_duration_in_seconds" integer,
	"status" "session_status" DEFAULT 'pending' NOT NULL,
	"session_feedback" text
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"performed_by" integer NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_user_id" integer,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_profiles" ADD CONSTRAINT "patient_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_profiles" ADD CONSTRAINT "practitioner_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_clinics" ADD CONSTRAINT "user_clinics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_clinics" ADD CONSTRAINT "user_clinics_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_files" ADD CONSTRAINT "medical_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD CONSTRAINT "assigned_program_exercises_assigned_program_id_assigned_programs_id_fk" FOREIGN KEY ("assigned_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_program_exercises" ADD CONSTRAINT "assigned_program_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_programs" ADD CONSTRAINT "assigned_programs_based_on_template_id_program_templates_id_fk" FOREIGN KEY ("based_on_template_id") REFERENCES "public"."program_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_exercises" ADD CONSTRAINT "template_exercises_template_id_program_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."program_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_exercises" ADD CONSTRAINT "template_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_assigned_program_exercise_id_assigned_program_exercises_id_fk" FOREIGN KEY ("assigned_program_exercise_id") REFERENCES "public"."assigned_program_exercises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_assigned_program_id_assigned_programs_id_fk" FOREIGN KEY ("assigned_program_id") REFERENCES "public"."assigned_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_external_id_unique" ON "exercises" USING btree ("external_id") WHERE "exercises"."external_id" IS NOT NULL;