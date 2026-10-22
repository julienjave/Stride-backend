CREATE TYPE "public"."email_change_cancel_reason" AS ENUM('replaced', 'cancelled_in_app', 'cancelled_by_email_link', 'password_reset');--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"new_email" varchar(255) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"cancel_token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" "email_change_cancel_reason",
	CONSTRAINT "email_change_requests_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "email_change_requests_cancel_token_hash_unique" UNIQUE("cancel_token_hash"),
	CONSTRAINT "email_change_requests_confirmed_or_cancelled" CHECK ("email_change_requests"."confirmed_at" IS NULL OR "email_change_requests"."cancelled_at" IS NULL),
	CONSTRAINT "email_change_requests_cancelled_with_reason" CHECK (("email_change_requests"."cancelled_at" IS NULL) = ("email_change_requests"."cancel_reason" IS NULL)),
	CONSTRAINT "email_change_requests_expires_after_creation" CHECK ("email_change_requests"."expires_at" > "email_change_requests"."created_at"),
	CONSTRAINT "email_change_requests_new_email_normalized" CHECK ("email_change_requests"."new_email" = btrim(lower("email_change_requests"."new_email" COLLATE "C")))
);
--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_change_requests_one_open_per_user" ON "email_change_requests" USING btree ("user_id") WHERE "email_change_requests"."confirmed_at" IS NULL AND "email_change_requests"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_change_requests_user_id_idx" ON "email_change_requests" USING btree ("user_id");