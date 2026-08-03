CREATE TABLE "cost_estimates" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"estimate_name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"reconstruction_id" uuid,
	"status" text,
	"currency" text,
	"sand_loss_pct" numeric,
	"dredged_fill_loss_pct" numeric,
	"perimeter_margin_pct" numeric,
	"pvd_area_fraction" numeric,
	"pvd_spacing_m" numeric,
	"contingency_pct" numeric,
	"subtotal" jsonb,
	"contingency" jsonb,
	"total" jsonb,
	"lines_json" text,
	"priced_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('cost_estimates'::regclass, 'cost_estimates_history');
--> statement-breakpoint
CREATE TABLE "cost_rates" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"substrate" text NOT NULL,
	"label" text NOT NULL,
	"unit" text NOT NULL,
	"rate" jsonb,
	"rate_basis" text,
	"source" text,
	"validity_range" jsonb,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('cost_rates'::regclass, 'cost_rates_history');
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text NOT NULL,
	"project_id" uuid NOT NULL,
	"category" text NOT NULL,
	"document_role" text,
	"document_file" uuid NOT NULL,
	"document_number" text,
	"discipline" text,
	"revision" text,
	"issued_on" date,
	"issued_by" text,
	"status" text,
	"tags" text[],
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('project_documents'::regclass, 'project_documents_history');
--> statement-breakpoint
CREATE TABLE "reclamation_projects" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"project_name" text NOT NULL,
	"project_code" text,
	"client" text,
	"consultant" text,
	"status" text,
	"location" text,
	"datum" text,
	"currency" text,
	"floor_plan_document" uuid,
	"bathymetry_document" uuid,
	"cross_section_document" uuid,
	"interpolation" text,
	"integration_cell_m" numeric,
	"render_cell_m" numeric,
	"stitch_overrides" text,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('reclamation_projects'::regclass, 'reclamation_projects_history');
--> statement-breakpoint
CREATE TABLE "site_reconstructions" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"project_id" uuid NOT NULL,
	"revision" numeric NOT NULL,
	"status" text NOT NULL,
	"stitched_at" timestamp with time zone,
	"engine_version" text,
	"failure_reason" text,
	"platform_area_m2" numeric,
	"placed_volume_m3" numeric,
	"mean_fill_depth_m" numeric,
	"excavation_m3" numeric,
	"integration_cell_m" numeric,
	"assumption_count" numeric,
	"warning_count" numeric,
	"model_json" text,
	"metrics_json" text,
	"quantities_json" text,
	"report_json" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('site_reconstructions'::regclass, 'site_reconstructions_history');
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"approval_config_id" uuid NOT NULL,
	"collection_name" text NOT NULL,
	"status" text NOT NULL,
	"approval_step_nodes" jsonb DEFAULT '[]' NOT NULL,
	"locked_record_refs" jsonb DEFAULT '[]' NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('approval_request'::regclass, 'approval_request_history');
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"event_type" text DEFAULT 'mutation' NOT NULL,
	"collection_name" text,
	"record_id" uuid,
	"details" jsonb DEFAULT '{}',
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "automation_run" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"automation_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}',
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('automation_run'::regclass, 'automation_run_history');
--> statement-breakpoint
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
	"usage" jsonb,
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
CREATE TABLE "chat_session" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"user_id" uuid NOT NULL,
	"automation_run_id" uuid,
	"title" text NOT NULL,
	"platform" text,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"external_thread_id" text,
	"agent_profile_id" uuid,
	"channel_config_id" uuid,
	"assigned_channel_id" uuid,
	"usage_cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage_total_tokens" integer DEFAULT 0 NOT NULL,
	"usage_turns_counted" integer DEFAULT 0 NOT NULL,
	"usage_turns_unreported" integer DEFAULT 0 NOT NULL
);
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
	"ended_at" timestamp with time zone,
	"usage_settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_asset" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"file_size" integer,
	"storage_key" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('document_asset'::regclass, 'document_asset_history');
--> statement-breakpoint
CREATE TABLE "host_event_outbox" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"event" text NOT NULL,
	"reason" text NOT NULL,
	"subject_hmac" text,
	"seats" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('host_event_outbox'::regclass, 'host_event_outbox_history');
--> statement-breakpoint
CREATE TABLE "integration_cursor" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"integration_name" text NOT NULL,
	"binding_name" text NOT NULL,
	"binding_key" text NOT NULL UNIQUE,
	"cursor" text,
	"last_pulled_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('integration_cursor'::regclass, 'integration_cursor_history');
--> statement-breakpoint
CREATE TABLE "integration_inbound_event" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"integration_name" text NOT NULL,
	"binding_name" text NOT NULL,
	"binding_key" text NOT NULL,
	"event_id" text NOT NULL,
	"receipt_key" text NOT NULL UNIQUE,
	"status" text DEFAULT 'received' NOT NULL,
	"imported" integer,
	"error" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('integration_inbound_event'::regclass, 'integration_inbound_event_history');
--> statement-breakpoint
CREATE TABLE "integration_outbox" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"integration_name" text NOT NULL,
	"binding_name" text NOT NULL,
	"collection_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('integration_outbox'::regclass, 'integration_outbox_history');
--> statement-breakpoint
CREATE TABLE "invitation" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"email" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"role" text DEFAULT 'basic' NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_user_id" uuid
);
--> statement-breakpoint
SELECT _norbital_create_history_table('invitation'::regclass, 'invitation_history');
--> statement-breakpoint
CREATE TABLE "notification" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"channels" jsonb DEFAULT '[]',
	"cta_label" text,
	"cta_url" text,
	"notification_category" text,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('notification'::regclass, 'notification_history');
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"channel" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"cta_label" text,
	"cta_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('notification_outbox'::regclass, 'notification_outbox_history');
--> statement-breakpoint
CREATE TABLE "policy" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"accessible_applications" jsonb DEFAULT '[]',
	"grants" jsonb DEFAULT '[]'
);
--> statement-breakpoint
SELECT _norbital_create_history_table('policy'::regclass, 'policy_history');
--> statement-breakpoint
CREATE TABLE "requestor" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"approval_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('requestor'::regclass, 'requestor_history');
--> statement-breakpoint
CREATE TABLE "team" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"parent_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"kind" text DEFAULT 'human',
	"policy_id" uuid
);
--> statement-breakpoint
SELECT _norbital_create_history_table('team'::regclass, 'team_history');
--> statement-breakpoint
CREATE TABLE "team_members" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('team_members'::regclass, 'team_members_history');
--> statement-breakpoint
CREATE TABLE "user" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"email" text NOT NULL UNIQUE,
	"name" text,
	"avatar_url" text,
	"status" text DEFAULT 'active',
	"role" text DEFAULT 'basic',
	"kind" text DEFAULT 'human',
	"channels" jsonb DEFAULT '[]'
);
--> statement-breakpoint
SELECT _norbital_create_history_table('user'::regclass, 'user_history');
--> statement-breakpoint
CREATE INDEX "cost_estimates_project_id_index" ON "cost_estimates" ("project_id");
--> statement-breakpoint
CREATE INDEX "cost_estimates_estimate_name_search_trgm_idx" ON "cost_estimates" USING gin ("estimate_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_estimates_status_search_trgm_idx" ON "cost_estimates" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_estimates_currency_search_trgm_idx" ON "cost_estimates" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_estimates_lines_json_search_trgm_idx" ON "cost_estimates" USING gin ("lines_json" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_estimates_notes_search_trgm_idx" ON "cost_estimates" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "cost_rates_substrate_index" ON "cost_rates" ("substrate");
--> statement-breakpoint
CREATE INDEX "cost_rates_substrate_search_trgm_idx" ON "cost_rates" USING gin ("substrate" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_rates_label_search_trgm_idx" ON "cost_rates" USING gin ("label" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_rates_unit_search_trgm_idx" ON "cost_rates" USING gin ("unit" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_rates_rate_basis_search_trgm_idx" ON "cost_rates" USING gin ("rate_basis" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_rates_source_search_trgm_idx" ON "cost_rates" USING gin ("source" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "cost_rates_notes_search_trgm_idx" ON "cost_rates" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_project_id_index" ON "project_documents" ("project_id");
--> statement-breakpoint
CREATE INDEX "project_documents_category_index" ON "project_documents" ("category");
--> statement-breakpoint
CREATE INDEX "project_documents_title_search_trgm_idx" ON "project_documents" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_category_search_trgm_idx" ON "project_documents" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_document_role_search_trgm_idx" ON "project_documents" USING gin ("document_role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_document_number_search_trgm_idx" ON "project_documents" USING gin ("document_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_discipline_search_trgm_idx" ON "project_documents" USING gin ("discipline" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_revision_search_trgm_idx" ON "project_documents" USING gin ("revision" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_issued_by_search_trgm_idx" ON "project_documents" USING gin ("issued_by" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_status_search_trgm_idx" ON "project_documents" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "project_documents_notes_search_trgm_idx" ON "project_documents" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "reclamation_projects_project_code_index" ON "reclamation_projects" ("project_code");
--> statement-breakpoint
CREATE INDEX "reclamation_projects_project_name_search_trgm_idx" ON "reclamation_projects" USING gin ("project_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_project_code_search_trgm_idx" ON "reclamation_projects" USING gin ("project_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_client_search_trgm_idx" ON "reclamation_projects" USING gin ("client" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_consultant_search_trgm_idx" ON "reclamation_projects" USING gin ("consultant" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_status_search_trgm_idx" ON "reclamation_projects" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_location_search_trgm_idx" ON "reclamation_projects" USING gin ("location" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_datum_search_trgm_idx" ON "reclamation_projects" USING gin ("datum" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_currency_search_trgm_idx" ON "reclamation_projects" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_interpolation_search_trgm_idx" ON "reclamation_projects" USING gin ("interpolation" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_stitch_overrides_search_trgm_idx" ON "reclamation_projects" USING gin ("stitch_overrides" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "reclamation_projects_notes_search_trgm_idx" ON "reclamation_projects" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_project_id_index" ON "site_reconstructions" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "site_reconstructions_project_id_revision_index" ON "site_reconstructions" ("project_id","revision");
--> statement-breakpoint
CREATE INDEX "site_reconstructions_status_search_trgm_idx" ON "site_reconstructions" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_engine_version_search_trgm_idx" ON "site_reconstructions" USING gin ("engine_version" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_failure_reason_search_trgm_idx" ON "site_reconstructions" USING gin ("failure_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_model_json_search_trgm_idx" ON "site_reconstructions" USING gin ("model_json" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_metrics_json_search_trgm_idx" ON "site_reconstructions" USING gin ("metrics_json" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_quantities_json_search_trgm_idx" ON "site_reconstructions" USING gin ("quantities_json" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_reconstructions_report_json_search_trgm_idx" ON "site_reconstructions" USING gin ("report_json" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "approval_request_label_search_trgm_idx" ON "approval_request" USING gin ("label" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "approval_request_collection_name_search_trgm_idx" ON "approval_request" USING gin ("collection_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "approval_request_status_search_trgm_idx" ON "approval_request" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "audit_event_event_type_search_trgm_idx" ON "audit_event" USING gin ("event_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "audit_event_collection_name_search_trgm_idx" ON "audit_event" USING gin ("collection_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "automation_run_automation_name_search_trgm_idx" ON "automation_run" USING gin ("automation_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "automation_run_status_search_trgm_idx" ON "automation_run" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "automation_run_error_search_trgm_idx" ON "automation_run" USING gin ("error" gin_trgm_ops);
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
CREATE INDEX "document_asset_file_name_search_trgm_idx" ON "document_asset" USING gin ("file_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "document_asset_mime_type_search_trgm_idx" ON "document_asset" USING gin ("mime_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "document_asset_storage_key_search_trgm_idx" ON "document_asset" USING gin ("storage_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "host_event_outbox_event_search_trgm_idx" ON "host_event_outbox" USING gin ("event" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "host_event_outbox_reason_search_trgm_idx" ON "host_event_outbox" USING gin ("reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "host_event_outbox_subject_hmac_search_trgm_idx" ON "host_event_outbox" USING gin ("subject_hmac" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "host_event_outbox_status_search_trgm_idx" ON "host_event_outbox" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "host_event_outbox_last_error_search_trgm_idx" ON "host_event_outbox" USING gin ("last_error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_integration_name_search_trgm_idx" ON "integration_cursor" USING gin ("integration_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_binding_name_search_trgm_idx" ON "integration_cursor" USING gin ("binding_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_binding_key_search_trgm_idx" ON "integration_cursor" USING gin ("binding_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_cursor_search_trgm_idx" ON "integration_cursor" USING gin ("cursor" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_last_error_search_trgm_idx" ON "integration_cursor" USING gin ("last_error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_integration_name_search_trgm_idx" ON "integration_inbound_event" USING gin ("integration_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_binding_name_search_trgm_idx" ON "integration_inbound_event" USING gin ("binding_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_binding_key_search_trgm_idx" ON "integration_inbound_event" USING gin ("binding_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_event_id_search_trgm_idx" ON "integration_inbound_event" USING gin ("event_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_receipt_key_search_trgm_idx" ON "integration_inbound_event" USING gin ("receipt_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_status_search_trgm_idx" ON "integration_inbound_event" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_inbound_event_error_search_trgm_idx" ON "integration_inbound_event" USING gin ("error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_integration_name_search_trgm_idx" ON "integration_outbox" USING gin ("integration_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_binding_name_search_trgm_idx" ON "integration_outbox" USING gin ("binding_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_collection_name_search_trgm_idx" ON "integration_outbox" USING gin ("collection_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_action_search_trgm_idx" ON "integration_outbox" USING gin ("action" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_status_search_trgm_idx" ON "integration_outbox" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_outbox_last_error_search_trgm_idx" ON "integration_outbox" USING gin ("last_error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invitation_email_search_trgm_idx" ON "invitation" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invitation_token_hash_search_trgm_idx" ON "invitation" USING gin ("token_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invitation_role_search_trgm_idx" ON "invitation" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_subject_search_trgm_idx" ON "notification" USING gin ("subject" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_message_search_trgm_idx" ON "notification" USING gin ("message" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_cta_label_search_trgm_idx" ON "notification" USING gin ("cta_label" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_cta_url_search_trgm_idx" ON "notification" USING gin ("cta_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_notification_category_search_trgm_idx" ON "notification" USING gin ("notification_category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_channel_search_trgm_idx" ON "notification_outbox" USING gin ("channel" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_subject_search_trgm_idx" ON "notification_outbox" USING gin ("subject" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_message_search_trgm_idx" ON "notification_outbox" USING gin ("message" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_cta_label_search_trgm_idx" ON "notification_outbox" USING gin ("cta_label" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_cta_url_search_trgm_idx" ON "notification_outbox" USING gin ("cta_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_status_search_trgm_idx" ON "notification_outbox" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "notification_outbox_last_error_search_trgm_idx" ON "notification_outbox" USING gin ("last_error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "policy_key_search_trgm_idx" ON "policy" USING gin ("key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "policy_name_search_trgm_idx" ON "policy" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "policy_description_search_trgm_idx" ON "policy" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "team_name_search_trgm_idx" ON "team" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "team_description_search_trgm_idx" ON "team" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "team_parent_id_search_trgm_idx" ON "team" USING gin ("parent_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "team_kind_search_trgm_idx" ON "team" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_email_search_trgm_idx" ON "user" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_name_search_trgm_idx" ON "user" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_avatar_url_search_trgm_idx" ON "user" USING gin ("avatar_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_status_search_trgm_idx" ON "user" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_role_search_trgm_idx" ON "user" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_kind_search_trgm_idx" ON "user" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_reconstruction_id_site_reconstructions_fk" FOREIGN KEY ("reconstruction_id") REFERENCES "site_reconstructions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "site_reconstructions" ADD CONSTRAINT "site_reconstructions_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_requested_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_X3p24605t0lh_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversation"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_Oyde72058Ltn_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_message"("norbital_id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_turn_id_chat_turn_norbital_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat_turn"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_author_user_id_user_norbital_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_automation_run_id_automation_run_norbital_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_turn" ADD CONSTRAINT "chat_turn_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "document_asset" ADD CONSTRAINT "document_asset_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_consumed_user_id_user_norbital_id_fkey" FOREIGN KEY ("consumed_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_user_norbital_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_user_norbital_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_approval_request_id_approval_request_norbital_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("norbital_id");
--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_policy_id_policy_norbital_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("norbital_id");
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_team_norbital_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("norbital_id");
