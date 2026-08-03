CREATE TABLE "channel_conversation" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"channel_key" text NOT NULL,
	"transport" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"binding_key" text NOT NULL UNIQUE,
	"chat_id" uuid NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('channel_conversation'::regclass, 'channel_conversation_history');
--> statement-breakpoint
CREATE TABLE "channel_inbound_message" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"channel_key" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_conversation_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"receipt_key" text NOT NULL UNIQUE,
	"sender_external_id" text,
	"sender_display_name" text,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"chat_message_id" uuid,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('channel_inbound_message'::regclass, 'channel_inbound_message_history');
--> statement-breakpoint
CREATE INDEX "channel_conversation_channel_key_search_trgm_idx" ON "channel_conversation" USING gin ("channel_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_conversation_transport_search_trgm_idx" ON "channel_conversation" USING gin ("transport" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_conversation_external_conversation_id_search_trgm_idx" ON "channel_conversation" USING gin ("external_conversation_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_conversation_binding_key_search_trgm_idx" ON "channel_conversation" USING gin ("binding_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_channel_key_search_trgm_idx" ON "channel_inbound_message" USING gin ("channel_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_external_conversation__1r0vk1q_trgm_idx" ON "channel_inbound_message" USING gin ("external_conversation_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_external_message_id_search_trgm_idx" ON "channel_inbound_message" USING gin ("external_message_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_receipt_key_search_trgm_idx" ON "channel_inbound_message" USING gin ("receipt_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_sender_external_id_search_trgm_idx" ON "channel_inbound_message" USING gin ("sender_external_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_sender_display_name_search_trgm_idx" ON "channel_inbound_message" USING gin ("sender_display_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_status_search_trgm_idx" ON "channel_inbound_message" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "channel_inbound_message_error_search_trgm_idx" ON "channel_inbound_message" USING gin ("error" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_X3p24605t0lh_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversation"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_Oyde72058Ltn_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_message"("norbital_id") ON DELETE SET NULL;
