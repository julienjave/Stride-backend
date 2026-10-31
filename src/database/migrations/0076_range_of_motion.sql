CREATE TYPE "public"."rom_mode" AS ENUM('active', 'passive');--> statement-breakpoint
CREATE TYPE "public"."rom_movement" AS ENUM('cervical_flexion', 'cervical_extension', 'cervical_lateral_flexion', 'cervical_rotation', 'shoulder_flexion', 'shoulder_extension', 'shoulder_abduction', 'shoulder_internal_rotation', 'shoulder_external_rotation', 'elbow_flexion', 'elbow_extension', 'forearm_pronation', 'forearm_supination', 'wrist_flexion', 'wrist_extension', 'wrist_radial_deviation', 'wrist_ulnar_deviation', 'thoracolumbar_flexion', 'thoracolumbar_extension', 'thoracolumbar_lateral_flexion', 'thoracolumbar_rotation', 'hip_flexion', 'hip_extension', 'hip_abduction', 'hip_adduction', 'hip_internal_rotation', 'hip_external_rotation', 'knee_flexion', 'knee_extension', 'ankle_dorsiflexion', 'ankle_plantarflexion', 'ankle_inversion', 'ankle_eversion');--> statement-breakpoint
CREATE TYPE "public"."rom_side" AS ENUM('left', 'right');--> statement-breakpoint
CREATE TABLE "rom_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"measured_on" date NOT NULL,
	"medical_file_entry_id" integer,
	"amends_id" integer,
	"amendment_reason" text,
	CONSTRAINT "rom_assessments_id_patient_unique" UNIQUE("id","patient_id"),
	CONSTRAINT "rom_assessments_one_amendment_per_assessment" UNIQUE("amends_id"),
	CONSTRAINT "rom_assessments_not_self_amending" CHECK ("rom_assessments"."amends_id" IS NULL OR "rom_assessments"."amends_id" <> "rom_assessments"."id"),
	CONSTRAINT "rom_assessments_amendment_reason_valid" CHECK (("rom_assessments"."amends_id" IS NULL) = ("rom_assessments"."amendment_reason" IS NULL) AND ("rom_assessments"."amendment_reason" IS NULL OR ("rom_assessments"."amendment_reason" ~ '\S' AND char_length("rom_assessments"."amendment_reason") <= 500))),
	CONSTRAINT "rom_assessments_measured_by_recording" CHECK ("rom_assessments"."measured_on" <= ("rom_assessments"."created_at" AT TIME ZONE 'UTC')::date + 1)
);
--> statement-breakpoint
CREATE TABLE "rom_measurements" (
	"id" serial PRIMARY KEY NOT NULL,
	"assessment_id" integer NOT NULL,
	"movement" "rom_movement" NOT NULL,
	"side" "rom_side",
	"mode" "rom_mode" NOT NULL,
	"degrees" smallint NOT NULL,
	"note" text,
	CONSTRAINT "rom_measurements_one_value_per_kind" UNIQUE NULLS NOT DISTINCT("assessment_id","movement","side","mode"),
	CONSTRAINT "rom_measurements_side_matches_movement" CHECK ((side IS NOT NULL) = (movement IN ('cervical_lateral_flexion', 'cervical_rotation', 'shoulder_flexion', 'shoulder_extension', 'shoulder_abduction', 'shoulder_internal_rotation', 'shoulder_external_rotation', 'elbow_flexion', 'elbow_extension', 'forearm_pronation', 'forearm_supination', 'wrist_flexion', 'wrist_extension', 'wrist_radial_deviation', 'wrist_ulnar_deviation', 'thoracolumbar_lateral_flexion', 'thoracolumbar_rotation', 'hip_flexion', 'hip_extension', 'hip_abduction', 'hip_adduction', 'hip_internal_rotation', 'hip_external_rotation', 'knee_flexion', 'knee_extension', 'ankle_dorsiflexion', 'ankle_plantarflexion', 'ankle_inversion', 'ankle_eversion'))),
	CONSTRAINT "rom_measurements_degrees_plausible" CHECK (CASE WHEN movement IN ('elbow_extension', 'knee_extension') THEN degrees BETWEEN -90 AND 20 WHEN movement IN ('ankle_eversion') THEN degrees BETWEEN -90 AND 35 WHEN movement IN ('wrist_radial_deviation', 'ankle_dorsiflexion') THEN degrees BETWEEN -90 AND 40 WHEN movement IN ('thoracolumbar_extension') THEN degrees BETWEEN -90 AND 45 WHEN movement IN ('wrist_ulnar_deviation', 'hip_extension', 'hip_adduction') THEN degrees BETWEEN -90 AND 50 WHEN movement IN ('thoracolumbar_lateral_flexion', 'ankle_inversion') THEN degrees BETWEEN -90 AND 55 WHEN movement IN ('cervical_flexion', 'cervical_extension', 'cervical_lateral_flexion', 'thoracolumbar_rotation', 'hip_abduction', 'hip_internal_rotation', 'hip_external_rotation') THEN degrees BETWEEN -90 AND 70 WHEN movement IN ('ankle_plantarflexion') THEN degrees BETWEEN -90 AND 75 WHEN movement IN ('cervical_rotation', 'shoulder_extension') THEN degrees BETWEEN -90 AND 90 WHEN movement IN ('shoulder_internal_rotation', 'wrist_extension') THEN degrees BETWEEN -90 AND 105 WHEN movement IN ('forearm_pronation', 'forearm_supination', 'wrist_flexion', 'thoracolumbar_flexion') THEN degrees BETWEEN -90 AND 120 WHEN movement IN ('shoulder_external_rotation') THEN degrees BETWEEN -90 AND 135 WHEN movement IN ('hip_flexion') THEN degrees BETWEEN -90 AND 180 WHEN movement IN ('shoulder_flexion', 'shoulder_abduction', 'elbow_flexion', 'knee_flexion') THEN degrees BETWEEN -90 AND 200 ELSE false END),
	CONSTRAINT "rom_measurements_note_valid" CHECK (note IS NULL OR (note ~ '\S' AND char_length(note) <= 200))
);
--> statement-breakpoint
ALTER TABLE "rom_assessments" ADD CONSTRAINT "rom_assessments_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rom_assessments" ADD CONSTRAINT "rom_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rom_assessments" ADD CONSTRAINT "rom_assessments_amends_same_patient_fk" FOREIGN KEY ("amends_id","patient_id") REFERENCES "public"."rom_assessments"("id","patient_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rom_assessments" ADD CONSTRAINT "rom_assessments_note_same_patient_fk" FOREIGN KEY ("medical_file_entry_id","patient_id") REFERENCES "public"."medical_files"("id","patient_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rom_measurements" ADD CONSTRAINT "rom_measurements_assessment_id_rom_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."rom_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rom_assessments_patient_id_idx" ON "rom_assessments" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "rom_assessments_medical_file_entry_idx" ON "rom_assessments" USING btree ("medical_file_entry_id");