CREATE TABLE "asset_documents" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text NOT NULL,
	"document_number" text,
	"project_id" uuid,
	"site_location_id" uuid,
	"document_type" text,
	"asset_tag" text,
	"asset_category" text,
	"status" text,
	"validity_range" jsonb,
	"document_url" text,
	"version" text,
	"tags" text[]
);
--> statement-breakpoint
SELECT _norbital_create_history_table('asset_documents'::regclass, 'asset_documents_history');
--> statement-breakpoint
CREATE TABLE "bim_reference_matrix" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"reference_name" text NOT NULL,
	"reference_code" text,
	"project_id" uuid,
	"category" text,
	"subcategory" text,
	"unit_of_measure" text,
	"rate" jsonb,
	"embodied_carbon_per_unit" numeric,
	"carbon_unit" text,
	"specification" text,
	"bim_guid" text,
	"data_source" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('bim_reference_matrix'::regclass, 'bim_reference_matrix_history');
--> statement-breakpoint
CREATE TABLE "certification_types" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"certification_name" text NOT NULL,
	"certification_code" text,
	"category" text,
	"issuing_body" text,
	"validity_period_months" numeric,
	"requires_refresher" boolean,
	"description" text,
	"requirements" text[]
);
--> statement-breakpoint
SELECT _norbital_create_history_table('certification_types'::regclass, 'certification_types_history');
--> statement-breakpoint
CREATE TABLE "defects" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text NOT NULL,
	"defect_number" text,
	"project_id" uuid,
	"site_location_id" uuid,
	"job_id" uuid,
	"reported_by" text,
	"assigned_to" text,
	"category" text,
	"severity" text,
	"status" text,
	"description" text,
	"reported_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"closed_date" timestamp with time zone,
	"photos" uuid[],
	"resolution_notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('defects'::regclass, 'defects_history');
--> statement-breakpoint
CREATE TABLE "job_assignments" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"assignment_code" text,
	"job_id" uuid,
	"worker_id" uuid,
	"site_location_id" uuid,
	"role" text,
	"assignment_range" jsonb,
	"status" text,
	"hours_per_day" numeric,
	"required_certifications" text[]
);
--> statement-breakpoint
SELECT _norbital_create_history_table('job_assignments'::regclass, 'job_assignments_history');
--> statement-breakpoint
CREATE TABLE "jobs" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_title" text NOT NULL,
	"job_number" text,
	"project_id" uuid,
	"job_type" text,
	"status" text,
	"schedule_range" jsonb,
	"budget" jsonb,
	"bim_reference_id" uuid,
	"site_location_id" uuid,
	"description" text,
	"priority" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('jobs'::regclass, 'jobs_history');
--> statement-breakpoint
CREATE TABLE "jobs_certification_types" (
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
SELECT _norbital_create_history_table('jobs_certification_types'::regclass, 'jobs_certification_types_history');
--> statement-breakpoint
CREATE TABLE "jobs_site_locations" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"job_id" uuid NOT NULL,
	"site_location_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('jobs_site_locations'::regclass, 'jobs_site_locations_history');
--> statement-breakpoint
CREATE TABLE "payment_claims" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"claim_number" text NOT NULL,
	"project_id" uuid,
	"job_id" uuid,
	"claim_type" text,
	"status" text,
	"claimed_amount" jsonb,
	"certified_amount" jsonb,
	"claim_period" jsonb,
	"submitted_date" timestamp with time zone,
	"paid_date" timestamp with time zone,
	"description" text,
	"supporting_documents" uuid[]
);
--> statement-breakpoint
SELECT _norbital_create_history_table('payment_claims'::regclass, 'payment_claims_history');
--> statement-breakpoint
CREATE TABLE "permits_to_work" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"permit_number" text NOT NULL,
	"permit_type" text,
	"project_id" uuid,
	"site_location_id" uuid,
	"job_id" uuid,
	"worker_id" uuid,
	"status" text,
	"requested_date" timestamp with time zone,
	"validity_range" jsonb,
	"approved_by" text,
	"hazards_identified" text[],
	"control_measures" text[],
	"signatures" jsonb
);
--> statement-breakpoint
SELECT _norbital_create_history_table('permits_to_work'::regclass, 'permits_to_work_history');
--> statement-breakpoint
CREATE TABLE "permits_to_work_certification_types" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"permits_to_work_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('permits_to_work_certification_types'::regclass, 'permits_to_work_certification_types_history');
--> statement-breakpoint
CREATE TABLE "permits_to_work_workers" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"permits_to_work_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('permits_to_work_workers'::regclass, 'permits_to_work_workers_history');
--> statement-breakpoint
CREATE TABLE "projects" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"project_name" text NOT NULL,
	"project_number" text,
	"client" text,
	"main_contractor" text,
	"status" text,
	"schedule_range" jsonb,
	"contract_value" jsonb,
	"project_type" text,
	"address" jsonb,
	"project_manager" text,
	"description" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('projects'::regclass, 'projects_history');
--> statement-breakpoint
CREATE TABLE "rfis" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text NOT NULL,
	"rfi_number" text,
	"project_id" uuid,
	"asked_by" text,
	"assigned_to" text,
	"subject" text,
	"question" text,
	"answer" text,
	"status" text,
	"priority" text,
	"submitted_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"resolved_date" timestamp with time zone,
	"attachments" uuid[],
	"related_defect_id" uuid
);
--> statement-breakpoint
SELECT _norbital_create_history_table('rfis'::regclass, 'rfis_history');
--> statement-breakpoint
CREATE TABLE "site_locations" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"location_name" text NOT NULL,
	"location_code" text,
	"project_id" uuid,
	"location_type" text,
	"parent_location_id" uuid,
	"grid_reference" text,
	"description" text,
	"coordinates" jsonb,
	"bim_model_element_id" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('site_locations'::regclass, 'site_locations_history');
--> statement-breakpoint
CREATE TABLE "workers" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"worker_name" text NOT NULL,
	"worker_number" text,
	"trade" text,
	"status" text,
	"phone" text,
	"email" text,
	"emergency_contact" jsonb,
	"date_of_birth" timestamp with time zone,
	"nationality" text,
	"work_permit_expiry" timestamp with time zone,
	"medical_check_date" timestamp with time zone,
	"safety_induction_date" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('workers'::regclass, 'workers_history');
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
CREATE UNIQUE INDEX "asset_documents_document_number_index" ON "asset_documents" ("document_number");
--> statement-breakpoint
CREATE INDEX "asset_documents_title_search_trgm_idx" ON "asset_documents" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_document_number_search_trgm_idx" ON "asset_documents" USING gin ("document_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_document_type_search_trgm_idx" ON "asset_documents" USING gin ("document_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_asset_tag_search_trgm_idx" ON "asset_documents" USING gin ("asset_tag" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_asset_category_search_trgm_idx" ON "asset_documents" USING gin ("asset_category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_status_search_trgm_idx" ON "asset_documents" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_document_url_search_trgm_idx" ON "asset_documents" USING gin ("document_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "asset_documents_version_search_trgm_idx" ON "asset_documents" USING gin ("version" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "bim_reference_matrix_reference_code_index" ON "bim_reference_matrix" ("reference_code");
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_reference_name_search_trgm_idx" ON "bim_reference_matrix" USING gin ("reference_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_reference_code_search_trgm_idx" ON "bim_reference_matrix" USING gin ("reference_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_category_search_trgm_idx" ON "bim_reference_matrix" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_subcategory_search_trgm_idx" ON "bim_reference_matrix" USING gin ("subcategory" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_unit_of_measure_search_trgm_idx" ON "bim_reference_matrix" USING gin ("unit_of_measure" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_carbon_unit_search_trgm_idx" ON "bim_reference_matrix" USING gin ("carbon_unit" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_specification_search_trgm_idx" ON "bim_reference_matrix" USING gin ("specification" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_bim_guid_search_trgm_idx" ON "bim_reference_matrix" USING gin ("bim_guid" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bim_reference_matrix_data_source_search_trgm_idx" ON "bim_reference_matrix" USING gin ("data_source" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "certification_types_certification_code_index" ON "certification_types" ("certification_code");
--> statement-breakpoint
CREATE INDEX "certification_types_certification_name_search_trgm_idx" ON "certification_types" USING gin ("certification_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_certification_code_search_trgm_idx" ON "certification_types" USING gin ("certification_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_category_search_trgm_idx" ON "certification_types" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_issuing_body_search_trgm_idx" ON "certification_types" USING gin ("issuing_body" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "certification_types_description_search_trgm_idx" ON "certification_types" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "defects_defect_number_index" ON "defects" ("defect_number");
--> statement-breakpoint
CREATE INDEX "defects_title_search_trgm_idx" ON "defects" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_defect_number_search_trgm_idx" ON "defects" USING gin ("defect_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_reported_by_search_trgm_idx" ON "defects" USING gin ("reported_by" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_assigned_to_search_trgm_idx" ON "defects" USING gin ("assigned_to" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_category_search_trgm_idx" ON "defects" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_severity_search_trgm_idx" ON "defects" USING gin ("severity" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_status_search_trgm_idx" ON "defects" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_description_search_trgm_idx" ON "defects" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "defects_resolution_notes_search_trgm_idx" ON "defects" USING gin ("resolution_notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_assignment_code_search_trgm_idx" ON "job_assignments" USING gin ("assignment_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_role_search_trgm_idx" ON "job_assignments" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_status_search_trgm_idx" ON "job_assignments" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_job_number_index" ON "jobs" ("job_number");
--> statement-breakpoint
CREATE INDEX "jobs_job_title_search_trgm_idx" ON "jobs" USING gin ("job_title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_job_number_search_trgm_idx" ON "jobs" USING gin ("job_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_job_type_search_trgm_idx" ON "jobs" USING gin ("job_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_status_search_trgm_idx" ON "jobs" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_description_search_trgm_idx" ON "jobs" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jobs_priority_search_trgm_idx" ON "jobs" USING gin ("priority" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_claim_number_index" ON "payment_claims" ("claim_number");
--> statement-breakpoint
CREATE INDEX "payment_claims_claim_number_search_trgm_idx" ON "payment_claims" USING gin ("claim_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payment_claims_claim_type_search_trgm_idx" ON "payment_claims" USING gin ("claim_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payment_claims_status_search_trgm_idx" ON "payment_claims" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payment_claims_description_search_trgm_idx" ON "payment_claims" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "permits_to_work_permit_number_index" ON "permits_to_work" ("permit_number");
--> statement-breakpoint
CREATE INDEX "permits_to_work_permit_number_search_trgm_idx" ON "permits_to_work" USING gin ("permit_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "permits_to_work_permit_type_search_trgm_idx" ON "permits_to_work" USING gin ("permit_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "permits_to_work_status_search_trgm_idx" ON "permits_to_work" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "permits_to_work_approved_by_search_trgm_idx" ON "permits_to_work" USING gin ("approved_by" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_project_number_index" ON "projects" ("project_number");
--> statement-breakpoint
CREATE INDEX "projects_project_name_search_trgm_idx" ON "projects" USING gin ("project_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_project_number_search_trgm_idx" ON "projects" USING gin ("project_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_client_search_trgm_idx" ON "projects" USING gin ("client" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_main_contractor_search_trgm_idx" ON "projects" USING gin ("main_contractor" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_status_search_trgm_idx" ON "projects" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_project_type_search_trgm_idx" ON "projects" USING gin ("project_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_project_manager_search_trgm_idx" ON "projects" USING gin ("project_manager" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "projects_description_search_trgm_idx" ON "projects" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "rfis_rfi_number_index" ON "rfis" ("rfi_number");
--> statement-breakpoint
CREATE INDEX "rfis_title_search_trgm_idx" ON "rfis" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_rfi_number_search_trgm_idx" ON "rfis" USING gin ("rfi_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_asked_by_search_trgm_idx" ON "rfis" USING gin ("asked_by" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_assigned_to_search_trgm_idx" ON "rfis" USING gin ("assigned_to" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_subject_search_trgm_idx" ON "rfis" USING gin ("subject" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_question_search_trgm_idx" ON "rfis" USING gin ("question" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_answer_search_trgm_idx" ON "rfis" USING gin ("answer" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_status_search_trgm_idx" ON "rfis" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rfis_priority_search_trgm_idx" ON "rfis" USING gin ("priority" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_locations_location_code_index" ON "site_locations" ("location_code");
--> statement-breakpoint
CREATE INDEX "site_locations_location_name_search_trgm_idx" ON "site_locations" USING gin ("location_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_locations_location_code_search_trgm_idx" ON "site_locations" USING gin ("location_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_locations_location_type_search_trgm_idx" ON "site_locations" USING gin ("location_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_locations_grid_reference_search_trgm_idx" ON "site_locations" USING gin ("grid_reference" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_locations_description_search_trgm_idx" ON "site_locations" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "site_locations_bim_model_element_id_search_trgm_idx" ON "site_locations" USING gin ("bim_model_element_id" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "workers_worker_number_index" ON "workers" ("worker_number");
--> statement-breakpoint
CREATE INDEX "workers_worker_name_search_trgm_idx" ON "workers" USING gin ("worker_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_worker_number_search_trgm_idx" ON "workers" USING gin ("worker_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_trade_search_trgm_idx" ON "workers" USING gin ("trade" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_status_search_trgm_idx" ON "workers" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_phone_search_trgm_idx" ON "workers" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_email_search_trgm_idx" ON "workers" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "workers_nationality_search_trgm_idx" ON "workers" USING gin ("nationality" gin_trgm_ops);
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
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_worker_id_workers_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_job_id_jobs_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("norbital_id");
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_site_location_id_site_locations_fk" FOREIGN KEY ("site_location_id") REFERENCES "site_locations"("norbital_id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "permits_to_work" ADD CONSTRAINT "permits_to_work_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
--> statement-breakpoint
ALTER TABLE "site_locations" ADD CONSTRAINT "site_locations_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");
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
