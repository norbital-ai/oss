CREATE TABLE "certification_types" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"issuing_body" text,
	"description" text,
	"active" boolean NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('certification_types'::regclass, 'certification_types_history');
--> statement-breakpoint
CREATE TABLE "contractor_certifications" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"contractor_profile_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('contractor_certifications'::regclass, 'contractor_certifications_history');
--> statement-breakpoint
CREATE TABLE "contractor_profiles" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"user_id" uuid NOT NULL,
	"company_name" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('contractor_profiles'::regclass, 'contractor_profiles_history');
--> statement-breakpoint
CREATE TABLE "job_assignments" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_id" uuid NOT NULL,
	"contractor_profile_id" uuid NOT NULL,
	"dispatched_at" timestamp with time zone,
	"status" text,
	"completed_at" timestamp with time zone,
	"amount_charged" jsonb,
	"location" jsonb,
	"summary" text,
	"source_message_id" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('job_assignments'::regclass, 'job_assignments_history');
--> statement-breakpoint
CREATE TABLE "job_certification_requirements" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('job_certification_requirements'::regclass, 'job_certification_requirements_history');
--> statement-breakpoint
CREATE TABLE "jobs" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"site_id" uuid NOT NULL,
	"title" text NOT NULL,
	"nature" text,
	"scheduled_for" date NOT NULL,
	"status" text,
	"description" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('jobs'::regclass, 'jobs_history');
--> statement-breakpoint
CREATE TABLE "photo_evidence" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_assignment_id" uuid,
	"variation_request_id" uuid,
	"document_asset_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"perceptual_hash" text NOT NULL,
	"flags" text[] NOT NULL,
	"matched_evidence_ids" uuid[] NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('photo_evidence'::regclass, 'photo_evidence_history');
--> statement-breakpoint
CREATE TABLE "sites" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"name" text NOT NULL,
	"location" jsonb,
	"client_name" text,
	"house_type" text,
	"floor_area_sqm" numeric
);
--> statement-breakpoint
SELECT _norbital_create_history_table('sites'::regclass, 'sites_history');
--> statement-breakpoint
CREATE TABLE "variation_requests" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_assignment_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"amount" jsonb,
	"source_message_id" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('variation_requests'::regclass, 'variation_requests_history');
--> statement-breakpoint
CREATE TABLE "agent_run_step" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"automation_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"content" text,
	"tool_call_id" text,
	"tool_name" text,
	"tool_input" jsonb,
	"tool_output" jsonb,
	"usage" jsonb
);
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
	"policy_id" uuid NOT NULL
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
	"role" text DEFAULT 'member',
	"kind" text DEFAULT 'human',
	"channels" jsonb DEFAULT '[]'
);
--> statement-breakpoint
SELECT _norbital_create_history_table('user'::regclass, 'user_history');
--> statement-breakpoint
CREATE UNIQUE INDEX "certification_types_code_index" ON "certification_types" ("code");
--> statement-breakpoint
CREATE INDEX "certification_types_code_search_trgm_idx" ON "certification_types" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_name_search_trgm_idx" ON "certification_types" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_category_search_trgm_idx" ON "certification_types" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_issuing_body_search_trgm_idx" ON "certification_types" USING gin ("issuing_body" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_description_search_trgm_idx" ON "certification_types" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_certifications_contractor_profile_id_certification_type_id_index" ON "contractor_certifications" ("contractor_profile_id","certification_type_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_profiles_user_id_index" ON "contractor_profiles" ("user_id");
--> statement-breakpoint
CREATE INDEX "contractor_profiles_company_name_search_trgm_idx" ON "contractor_profiles" USING gin ("company_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_assignments_source_message_id_index" ON "job_assignments" ("source_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "job_assignments_job_id_index" ON "job_assignments" ("job_id");
--> statement-breakpoint
CREATE INDEX "job_assignments_contractor_profile_id_index" ON "job_assignments" ("contractor_profile_id");
--> statement-breakpoint
CREATE INDEX "job_assignments_status_search_trgm_idx" ON "job_assignments" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_summary_search_trgm_idx" ON "job_assignments" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_source_message_id_search_trgm_idx" ON "job_assignments" USING gin ("source_message_id" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_certification_requirements_job_id_certification_type_id_index" ON "job_certification_requirements" ("job_id","certification_type_id");
--> statement-breakpoint
CREATE INDEX "jobs_title_search_trgm_idx" ON "jobs" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_nature_search_trgm_idx" ON "jobs" USING gin ("nature" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_status_search_trgm_idx" ON "jobs" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_description_search_trgm_idx" ON "jobs" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "photo_evidence_source_key_index" ON "photo_evidence" ("source_key");
--> statement-breakpoint
CREATE INDEX "photo_evidence_sha256_index" ON "photo_evidence" ("sha256");
--> statement-breakpoint
CREATE INDEX "photo_evidence_perceptual_hash_index" ON "photo_evidence" ("perceptual_hash");
--> statement-breakpoint
CREATE INDEX "photo_evidence_source_key_search_trgm_idx" ON "photo_evidence" USING gin ("source_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "photo_evidence_sha256_search_trgm_idx" ON "photo_evidence" USING gin ("sha256" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "photo_evidence_perceptual_hash_search_trgm_idx" ON "photo_evidence" USING gin ("perceptual_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sites_name_search_trgm_idx" ON "sites" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sites_client_name_search_trgm_idx" ON "sites" USING gin ("client_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sites_house_type_search_trgm_idx" ON "sites" USING gin ("house_type" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "variation_requests_source_message_id_index" ON "variation_requests" ("source_message_id");
--> statement-breakpoint
CREATE INDEX "variation_requests_title_search_trgm_idx" ON "variation_requests" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "variation_requests_description_search_trgm_idx" ON "variation_requests" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "variation_requests_source_message_id_search_trgm_idx" ON "variation_requests" USING gin ("source_message_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "agent_run_step_kind_search_trgm_idx" ON "agent_run_step" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "agent_run_step_role_search_trgm_idx" ON "agent_run_step" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "agent_run_step_content_search_trgm_idx" ON "agent_run_step" USING gin ("content" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "agent_run_step_tool_call_id_search_trgm_idx" ON "agent_run_step" USING gin ("tool_call_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "agent_run_step_tool_name_search_trgm_idx" ON "agent_run_step" USING gin ("tool_name" gin_trgm_ops);
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
CREATE INDEX "document_asset_file_name_search_trgm_idx" ON "document_asset" USING gin ("file_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "document_asset_mime_type_search_trgm_idx" ON "document_asset" USING gin ("mime_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "document_asset_storage_key_search_trgm_idx" ON "document_asset" USING gin ("storage_key" gin_trgm_ops);
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
ALTER TABLE "contractor_certifications" ADD CONSTRAINT "contractor_certifications_contractor_profile_id_contractor_profiles_fk" FOREIGN KEY ("contractor_profile_id") REFERENCES "contractor_profiles"("norbital_id");
--> statement-breakpoint
ALTER TABLE "contractor_certifications" ADD CONSTRAINT "contractor_certifications_certification_type_id_certification_types_fk" FOREIGN KEY ("certification_type_id") REFERENCES "certification_types"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_job_id_jobs_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_contractor_profile_id_contractor_profiles_fk" FOREIGN KEY ("contractor_profile_id") REFERENCES "contractor_profiles"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_certification_requirements" ADD CONSTRAINT "job_certification_requirements_job_id_jobs_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_certification_requirements" ADD CONSTRAINT "job_certification_requirements_certification_type_id_certification_types_fk" FOREIGN KEY ("certification_type_id") REFERENCES "certification_types"("norbital_id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_site_id_sites_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("norbital_id");
--> statement-breakpoint
ALTER TABLE "photo_evidence" ADD CONSTRAINT "photo_evidence_job_assignment_id_job_assignments_fk" FOREIGN KEY ("job_assignment_id") REFERENCES "job_assignments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "photo_evidence" ADD CONSTRAINT "photo_evidence_variation_request_id_variation_requests_fk" FOREIGN KEY ("variation_request_id") REFERENCES "variation_requests"("norbital_id");
--> statement-breakpoint
ALTER TABLE "variation_requests" ADD CONSTRAINT "variation_requests_job_assignment_id_job_assignments_fk" FOREIGN KEY ("job_assignment_id") REFERENCES "job_assignments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_774UFu3iuSmm_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_requested_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "document_asset" ADD CONSTRAINT "document_asset_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id");
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
