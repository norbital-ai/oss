ALTER TABLE "channel_conversation" ADD COLUMN "audience" text DEFAULT 'authenticated' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation_history" ADD COLUMN "audience" text DEFAULT 'authenticated' NOT NULL;
--> statement-breakpoint
CREATE INDEX "channel_conversation_audience_search_trgm_idx" ON "channel_conversation" USING gin ("audience" gin_trgm_ops);
