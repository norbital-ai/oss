CREATE TABLE "cost_estimates" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
	"missing_rates" text[],
	"priced_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "cost_rates" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "reclamation_projects" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "site_reconstructions" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"project_id" uuid NOT NULL,
	"revision" numeric NOT NULL,
	"status" text NOT NULL,
	"stitched_at" timestamp with time zone,
	"engine_version" text,
	"failure_reason" text,
	"platform_area_m2" numeric,
	"works_footprint_m2" numeric,
	"armor_face_area_m2" numeric,
	"shoreline_length_m" numeric,
	"mean_fill_depth_m" numeric,
	"max_fill_depth_m" numeric,
	"integration_cell_m" numeric,
	"structure_displacement_m3" numeric,
	"excavation_m3" numeric,
	"rock_armor_m3" numeric,
	"geofabric_m2" numeric,
	"dredged_rock_m3" numeric,
	"sand_key_m3" numeric,
	"sand_fill_m3" numeric,
	"dredged_fill_m3" numeric,
	"assumption_count" numeric,
	"warning_count" numeric,
	"model_json" text,
	"quantities_json" text,
	"report_json" text
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "audit_event" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"automation_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}',
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_session" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text,
	"messages" jsonb DEFAULT '[]',
	"context" jsonb DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "document_asset" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"file_name" text NOT NULL,
	"mime_type" text,
	"file_size" integer,
	"storage_key" text NOT NULL,
	"storage_provider" text DEFAULT 'minio',
	"metadata" jsonb DEFAULT '{}',
	"embedding_model" text
);
--> statement-breakpoint
CREATE TABLE "integration_outbox" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "mutation_log" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"collection_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}',
	"result" jsonb,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "policy" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "requestor" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"approval_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "team_members" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE INDEX "cost_estimates_project_id_index" ON "cost_estimates" ("project_id");--> statement-breakpoint
CREATE INDEX "cost_estimates_estimate_name_search_trgm_idx" ON "cost_estimates" USING gin ("estimate_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_estimates_status_search_trgm_idx" ON "cost_estimates" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_estimates_currency_search_trgm_idx" ON "cost_estimates" USING gin ("currency" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_estimates_lines_json_search_trgm_idx" ON "cost_estimates" USING gin ("lines_json" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_estimates_notes_search_trgm_idx" ON "cost_estimates" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "cost_rates_substrate_index" ON "cost_rates" ("substrate");--> statement-breakpoint
CREATE INDEX "cost_rates_substrate_search_trgm_idx" ON "cost_rates" USING gin ("substrate" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_rates_label_search_trgm_idx" ON "cost_rates" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_rates_unit_search_trgm_idx" ON "cost_rates" USING gin ("unit" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_rates_rate_basis_search_trgm_idx" ON "cost_rates" USING gin ("rate_basis" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_rates_source_search_trgm_idx" ON "cost_rates" USING gin ("source" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cost_rates_notes_search_trgm_idx" ON "cost_rates" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "reclamation_projects_project_code_index" ON "reclamation_projects" ("project_code");--> statement-breakpoint
CREATE INDEX "reclamation_projects_project_name_search_trgm_idx" ON "reclamation_projects" USING gin ("project_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_project_code_search_trgm_idx" ON "reclamation_projects" USING gin ("project_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_client_search_trgm_idx" ON "reclamation_projects" USING gin ("client" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_consultant_search_trgm_idx" ON "reclamation_projects" USING gin ("consultant" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_status_search_trgm_idx" ON "reclamation_projects" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_location_search_trgm_idx" ON "reclamation_projects" USING gin ("location" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_datum_search_trgm_idx" ON "reclamation_projects" USING gin ("datum" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_currency_search_trgm_idx" ON "reclamation_projects" USING gin ("currency" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_interpolation_search_trgm_idx" ON "reclamation_projects" USING gin ("interpolation" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_stitch_overrides_search_trgm_idx" ON "reclamation_projects" USING gin ("stitch_overrides" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reclamation_projects_notes_search_trgm_idx" ON "reclamation_projects" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_project_id_index" ON "site_reconstructions" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_reconstructions_project_id_revision_index" ON "site_reconstructions" ("project_id","revision");--> statement-breakpoint
CREATE INDEX "site_reconstructions_status_search_trgm_idx" ON "site_reconstructions" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_engine_version_search_trgm_idx" ON "site_reconstructions" USING gin ("engine_version" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_failure_reason_search_trgm_idx" ON "site_reconstructions" USING gin ("failure_reason" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_model_json_search_trgm_idx" ON "site_reconstructions" USING gin ("model_json" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_quantities_json_search_trgm_idx" ON "site_reconstructions" USING gin ("quantities_json" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_reconstructions_report_json_search_trgm_idx" ON "site_reconstructions" USING gin ("report_json" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_label_search_trgm_idx" ON "approval_request" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_collection_name_search_trgm_idx" ON "approval_request" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_status_search_trgm_idx" ON "approval_request" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_event_event_type_search_trgm_idx" ON "audit_event" USING gin ("event_type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_event_collection_name_search_trgm_idx" ON "audit_event" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_automation_name_search_trgm_idx" ON "automation_run" USING gin ("automation_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_status_search_trgm_idx" ON "automation_run" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_error_search_trgm_idx" ON "automation_run" USING gin ("error" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chat_session_title_search_trgm_idx" ON "chat_session" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_file_name_search_trgm_idx" ON "document_asset" USING gin ("file_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_mime_type_search_trgm_idx" ON "document_asset" USING gin ("mime_type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_storage_key_search_trgm_idx" ON "document_asset" USING gin ("storage_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_storage_provider_search_trgm_idx" ON "document_asset" USING gin ("storage_provider" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_embedding_model_search_trgm_idx" ON "document_asset" USING gin ("embedding_model" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_integration_name_search_trgm_idx" ON "integration_outbox" USING gin ("integration_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_binding_name_search_trgm_idx" ON "integration_outbox" USING gin ("binding_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_collection_name_search_trgm_idx" ON "integration_outbox" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_action_search_trgm_idx" ON "integration_outbox" USING gin ("action" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_status_search_trgm_idx" ON "integration_outbox" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_last_error_search_trgm_idx" ON "integration_outbox" USING gin ("last_error" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "mutation_log_collection_name_search_trgm_idx" ON "mutation_log" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "mutation_log_action_search_trgm_idx" ON "mutation_log" USING gin ("action" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_subject_search_trgm_idx" ON "notification" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_message_search_trgm_idx" ON "notification" USING gin ("message" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_cta_label_search_trgm_idx" ON "notification" USING gin ("cta_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_cta_url_search_trgm_idx" ON "notification" USING gin ("cta_url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_notification_category_search_trgm_idx" ON "notification" USING gin ("notification_category" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "policy_key_search_trgm_idx" ON "policy" USING gin ("key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "policy_name_search_trgm_idx" ON "policy" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "policy_description_search_trgm_idx" ON "policy" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "team_name_search_trgm_idx" ON "team" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "team_description_search_trgm_idx" ON "team" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "team_parent_id_search_trgm_idx" ON "team" USING gin ("parent_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "team_kind_search_trgm_idx" ON "team" USING gin ("kind" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_email_search_trgm_idx" ON "user" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_name_search_trgm_idx" ON "user" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_avatar_url_search_trgm_idx" ON "user" USING gin ("avatar_url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_status_search_trgm_idx" ON "user" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_role_search_trgm_idx" ON "user" USING gin ("role" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_kind_search_trgm_idx" ON "user" USING gin ("kind" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");--> statement-breakpoint
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_reconstruction_id_site_reconstructions_fk" FOREIGN KEY ("reconstruction_id") REFERENCES "site_reconstructions"("norbital_id");--> statement-breakpoint
ALTER TABLE "site_reconstructions" ADD CONSTRAINT "site_reconstructions_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "mutation_log" ADD CONSTRAINT "mutation_log_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_user_norbital_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_approval_request_id_approval_request_norbital_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("norbital_id");--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_policy_id_policy_norbital_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("norbital_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_team_norbital_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("norbital_id");