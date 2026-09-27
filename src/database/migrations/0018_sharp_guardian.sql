CREATE TABLE "care_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" integer,
	"ended_by" integer,
	"reason" varchar(255),
	CONSTRAINT "care_team_members_not_self" CHECK ("care_team_members"."patient_id" <> "care_team_members"."practitioner_id"),
	CONSTRAINT "care_team_members_ends_after_start" CHECK ("care_team_members"."ends_at" IS NULL OR "care_team_members"."ends_at" >= "care_team_members"."started_at")
);
--> statement-breakpoint
ALTER TABLE "care_team_members" ADD CONSTRAINT "care_team_members_patient_id_users_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_team_members" ADD CONSTRAINT "care_team_members_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_team_members" ADD CONSTRAINT "care_team_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_team_members" ADD CONSTRAINT "care_team_members_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_team_members_practitioner_id_idx" ON "care_team_members" USING btree ("practitioner_id");--> statement-breakpoint
CREATE INDEX "care_team_members_patient_id_idx" ON "care_team_members" USING btree ("patient_id");