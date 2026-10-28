CREATE TABLE "care_team_join_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"care_team_member_id" integer NOT NULL,
	"practitioner_id" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_team_join_reviews" ADD CONSTRAINT "care_team_join_reviews_practitioner_id_users_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_team_join_reviews" ADD CONSTRAINT "care_team_join_reviews_link_fk" FOREIGN KEY ("care_team_member_id") REFERENCES "public"."care_team_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "care_team_join_reviews_one_per_practitioner" ON "care_team_join_reviews" USING btree ("care_team_member_id","practitioner_id");