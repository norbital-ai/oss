DROP TABLE IF EXISTS "chat_message_history";
--> statement-breakpoint
DROP TABLE IF EXISTS "chat_session_history";
--> statement-breakpoint
DROP TABLE IF EXISTS "chat_turn_history";
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_cost_usd" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_total_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_turns_counted" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_turns_unreported" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_turn" ADD COLUMN "usage_settled_at" timestamp with time zone;
