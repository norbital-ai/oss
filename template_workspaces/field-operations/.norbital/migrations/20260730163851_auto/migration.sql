CREATE TABLE "chat_message" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"chat_id" uuid NOT NULL,
	"turn_id" uuid,
	"role" text NOT NULL,
	"seq" integer NOT NULL,
	"parts" jsonb,
	"model" text,
	"plan_mode" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"queue_status" text DEFAULT 'live' NOT NULL,
	"release_mode" text,
	"author_user_id" uuid,
	"author_display_name" text,
	"source_provider" text,
	"source_conversation_id" text,
	"source_message_id" text,
	"source_deleted_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('chat_message'::regclass, 'chat_message_history');
--> statement-breakpoint
CREATE TABLE "chat_session" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"platform" text,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"external_thread_id" text,
	"agent_profile_id" uuid,
	"channel_config_id" uuid,
	"assigned_channel_id" uuid
);
--> statement-breakpoint
SELECT _norbital_create_history_table('chat_session'::regclass, 'chat_session_history');
--> statement-breakpoint
CREATE TABLE "chat_turn" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"chat_id" uuid NOT NULL,
	"prompt_message_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text NOT NULL,
	"parent_turn_id" uuid,
	"subagent_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('chat_turn'::regclass, 'chat_turn_history');
--> statement-breakpoint
CREATE INDEX "chat_message_role_search_trgm_idx" ON "chat_message" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_model_search_trgm_idx" ON "chat_message" USING gin ("model" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_kind_search_trgm_idx" ON "chat_message" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_status_search_trgm_idx" ON "chat_message" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_queue_status_search_trgm_idx" ON "chat_message" USING gin ("queue_status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_release_mode_search_trgm_idx" ON "chat_message" USING gin ("release_mode" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_author_display_name_search_trgm_idx" ON "chat_message" USING gin ("author_display_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_provider_search_trgm_idx" ON "chat_message" USING gin ("source_provider" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_conversation_id_search_trgm_idx" ON "chat_message" USING gin ("source_conversation_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_message_id_search_trgm_idx" ON "chat_message" USING gin ("source_message_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_title_search_trgm_idx" ON "chat_session" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_platform_search_trgm_idx" ON "chat_session" USING gin ("platform" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_visibility_search_trgm_idx" ON "chat_session" USING gin ("visibility" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_external_thread_id_search_trgm_idx" ON "chat_session" USING gin ("external_thread_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_status_search_trgm_idx" ON "chat_turn" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_model_search_trgm_idx" ON "chat_turn" USING gin ("model" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_subagent_id_search_trgm_idx" ON "chat_turn" USING gin ("subagent_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_error_search_trgm_idx" ON "chat_turn" USING gin ("error" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_turn_id_chat_turn_norbital_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat_turn"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_author_user_id_user_norbital_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_turn" ADD CONSTRAINT "chat_turn_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
