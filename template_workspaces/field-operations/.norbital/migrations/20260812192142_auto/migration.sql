CREATE TABLE "channel_rate_limit" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"bucket_key" text NOT NULL UNIQUE,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "conversation_kind" text DEFAULT 'dm' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation_history" ADD COLUMN "conversation_kind" text DEFAULT 'dm' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "policy_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation_history" ADD COLUMN "policy_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "channel_conversation_history" ADD COLUMN "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "channel_key" text;
--> statement-breakpoint
CREATE INDEX "channel_conversation_conversation_kind_search_trgm_idx" ON "channel_conversation" USING gin ("conversation_kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_conversation_policy_key_search_trgm_idx" ON "channel_conversation" USING gin ("policy_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_rate_limit_bucket_key_search_trgm_idx" ON "channel_rate_limit" USING gin ("bucket_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_channel_key_search_trgm_idx" ON "chat_session" USING gin ("channel_key" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id") ON DELETE SET NULL;
