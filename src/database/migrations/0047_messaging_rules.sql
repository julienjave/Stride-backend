DROP INDEX "messages_conversation_id_idx";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_id_id_idx" ON "messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" USING btree ("conversation_id") WHERE "messages"."read_at" IS NULL AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
-- Hand-edited (Phase 5, like 0035): the rows that would break the two
-- CHECKs below are made valid FIRST — a CHECK added to a table with a row
-- that fails it makes the whole migration fail. Through REST such rows
-- could only be blank-but-not-empty ("   " passed @MinLength(1)); through
-- the WebSocket, which validated nothing, a message could also be longer
-- than 5000 characters. Blanks get a visible placeholder (nothing was said
-- in them); an over-long message keeps its first 5000 characters. Both are
-- edits of a message's text, done once here as the database owner — the
-- guard of 0048 makes the text fixed afterwards.
UPDATE "messages" SET "message_body" = '(empty message)' WHERE "message_body" !~ '\S';--> statement-breakpoint
UPDATE "messages" SET "message_body" = left("message_body", 5000) WHERE char_length("message_body") > 5000;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_not_blank" CHECK ("messages"."message_body" ~ '\S');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_max_length" CHECK (char_length("messages"."message_body") <= 5000);