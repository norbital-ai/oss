CREATE TABLE "accounts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"name" text NOT NULL,
	"industry" text,
	"website" text,
	"phone" text,
	"currency" text,
	"address" text,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"regarding_type" text NOT NULL,
	"regarding_id" uuid NOT NULL,
	"type" text,
	"subject" text NOT NULL,
	"description" text,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"owner_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"account_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"title" text,
	"department" text,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_prices" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"account_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_price" numeric NOT NULL,
	"currency" text,
	"valid_from" date,
	"valid_until" date,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_records" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"quote_id" uuid NOT NULL,
	"amount" jsonb,
	"payment_date" date NOT NULL,
	"method" text,
	"reference" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "products" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"grade" text,
	"mfi" text,
	"density" text,
	"supplier" text,
	"unit" text,
	"unit_price" numeric,
	"price_updated_at" timestamp with time zone,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"account_id" uuid NOT NULL,
	"status" text,
	"start_date" date,
	"end_date" date,
	"owner_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"quote_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"product_unit" text,
	"quantity" numeric NOT NULL,
	"unit_price" numeric NOT NULL,
	"discount_pct" numeric,
	"tax_rate" numeric,
	"line_total" numeric
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"doc_no" text NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"title" text NOT NULL,
	"status" text,
	"currency" text,
	"tax_inclusive" boolean NOT NULL,
	"valid_until" date,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"description" text,
	"project_id" uuid,
	"revision_of" uuid,
	"revision_number" numeric
);
--> statement-breakpoint
CREATE TABLE "agent_run_step" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE TABLE "document_asset" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"file_size" integer,
	"storage_key" text NOT NULL
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
CREATE TABLE "notification_outbox" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
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
CREATE INDEX "accounts_name_search_trgm_idx" ON "accounts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_industry_search_trgm_idx" ON "accounts" USING gin ("industry" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_website_search_trgm_idx" ON "accounts" USING gin ("website" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_phone_search_trgm_idx" ON "accounts" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_currency_search_trgm_idx" ON "accounts" USING gin ("currency" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_address_search_trgm_idx" ON "accounts" USING gin ("address" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activities_regarding_type_regarding_id_index" ON "activities" ("regarding_type","regarding_id");--> statement-breakpoint
CREATE INDEX "activities_owner_id_index" ON "activities" ("owner_id");--> statement-breakpoint
CREATE INDEX "activities_due_date_index" ON "activities" ("due_date");--> statement-breakpoint
CREATE INDEX "activities_regarding_type_search_trgm_idx" ON "activities" USING gin ("regarding_type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activities_type_search_trgm_idx" ON "activities" USING gin ("type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activities_subject_search_trgm_idx" ON "activities" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activities_description_search_trgm_idx" ON "activities" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_account_id_index" ON "contacts" ("account_id");--> statement-breakpoint
CREATE INDEX "contacts_first_name_search_trgm_idx" ON "contacts" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_last_name_search_trgm_idx" ON "contacts" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_search_trgm_idx" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_title_search_trgm_idx" ON "contacts" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_department_search_trgm_idx" ON "contacts" USING gin ("department" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customer_prices_account_id_product_id_index" ON "customer_prices" ("account_id","product_id");--> statement-breakpoint
CREATE INDEX "customer_prices_account_id_index" ON "customer_prices" ("account_id");--> statement-breakpoint
CREATE INDEX "customer_prices_product_id_index" ON "customer_prices" ("product_id");--> statement-breakpoint
CREATE INDEX "customer_prices_currency_search_trgm_idx" ON "customer_prices" USING gin ("currency" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payment_records_quote_id_index" ON "payment_records" ("quote_id");--> statement-breakpoint
CREATE INDEX "payment_records_payment_date_index" ON "payment_records" ("payment_date");--> statement-breakpoint
CREATE INDEX "payment_records_method_search_trgm_idx" ON "payment_records" USING gin ("method" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payment_records_reference_search_trgm_idx" ON "payment_records" USING gin ("reference" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payment_records_notes_search_trgm_idx" ON "payment_records" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_index" ON "products" ("code");--> statement-breakpoint
CREATE INDEX "products_grade_index" ON "products" ("grade");--> statement-breakpoint
CREATE INDEX "products_code_search_trgm_idx" ON "products" USING gin ("code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_name_search_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_description_search_trgm_idx" ON "products" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_grade_search_trgm_idx" ON "products" USING gin ("grade" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_mfi_search_trgm_idx" ON "products" USING gin ("mfi" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_density_search_trgm_idx" ON "products" USING gin ("density" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_supplier_search_trgm_idx" ON "products" USING gin ("supplier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_unit_search_trgm_idx" ON "products" USING gin ("unit" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_account_id_index" ON "projects" ("account_id");--> statement-breakpoint
CREATE INDEX "projects_owner_id_index" ON "projects" ("owner_id");--> statement-breakpoint
CREATE INDEX "projects_status_index" ON "projects" ("status");--> statement-breakpoint
CREATE INDEX "projects_name_search_trgm_idx" ON "projects" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_description_search_trgm_idx" ON "projects" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_status_search_trgm_idx" ON "projects" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quote_lines_quote_id_index" ON "quote_lines" ("quote_id");--> statement-breakpoint
CREATE INDEX "quote_lines_product_id_index" ON "quote_lines" ("product_id");--> statement-breakpoint
CREATE INDEX "quote_lines_product_code_search_trgm_idx" ON "quote_lines" USING gin ("product_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quote_lines_product_name_search_trgm_idx" ON "quote_lines" USING gin ("product_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quote_lines_product_unit_search_trgm_idx" ON "quote_lines" USING gin ("product_unit" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_doc_no_index" ON "quotes" ("doc_no");--> statement-breakpoint
CREATE INDEX "quotes_account_id_index" ON "quotes" ("account_id");--> statement-breakpoint
CREATE INDEX "quotes_owner_id_index" ON "quotes" ("owner_id");--> statement-breakpoint
CREATE INDEX "quotes_status_index" ON "quotes" ("status");--> statement-breakpoint
CREATE INDEX "quotes_project_id_index" ON "quotes" ("project_id");--> statement-breakpoint
CREATE INDEX "quotes_revision_of_index" ON "quotes" ("revision_of");--> statement-breakpoint
CREATE INDEX "quotes_doc_no_search_trgm_idx" ON "quotes" USING gin ("doc_no" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quotes_title_search_trgm_idx" ON "quotes" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quotes_status_search_trgm_idx" ON "quotes" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quotes_currency_search_trgm_idx" ON "quotes" USING gin ("currency" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "quotes_description_search_trgm_idx" ON "quotes" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_run_step_kind_search_trgm_idx" ON "agent_run_step" USING gin ("kind" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_run_step_role_search_trgm_idx" ON "agent_run_step" USING gin ("role" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_run_step_content_search_trgm_idx" ON "agent_run_step" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_run_step_tool_call_id_search_trgm_idx" ON "agent_run_step" USING gin ("tool_call_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_run_step_tool_name_search_trgm_idx" ON "agent_run_step" USING gin ("tool_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_label_search_trgm_idx" ON "approval_request" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_collection_name_search_trgm_idx" ON "approval_request" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_request_status_search_trgm_idx" ON "approval_request" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_event_event_type_search_trgm_idx" ON "audit_event" USING gin ("event_type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_event_collection_name_search_trgm_idx" ON "audit_event" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_automation_name_search_trgm_idx" ON "automation_run" USING gin ("automation_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_status_search_trgm_idx" ON "automation_run" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "automation_run_error_search_trgm_idx" ON "automation_run" USING gin ("error" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_file_name_search_trgm_idx" ON "document_asset" USING gin ("file_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_mime_type_search_trgm_idx" ON "document_asset" USING gin ("mime_type" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_asset_storage_key_search_trgm_idx" ON "document_asset" USING gin ("storage_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_integration_name_search_trgm_idx" ON "integration_outbox" USING gin ("integration_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_binding_name_search_trgm_idx" ON "integration_outbox" USING gin ("binding_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_collection_name_search_trgm_idx" ON "integration_outbox" USING gin ("collection_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_action_search_trgm_idx" ON "integration_outbox" USING gin ("action" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_status_search_trgm_idx" ON "integration_outbox" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "integration_outbox_last_error_search_trgm_idx" ON "integration_outbox" USING gin ("last_error" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_subject_search_trgm_idx" ON "notification" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_message_search_trgm_idx" ON "notification" USING gin ("message" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_cta_label_search_trgm_idx" ON "notification" USING gin ("cta_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_cta_url_search_trgm_idx" ON "notification" USING gin ("cta_url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_notification_category_search_trgm_idx" ON "notification" USING gin ("notification_category" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_channel_search_trgm_idx" ON "notification_outbox" USING gin ("channel" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_subject_search_trgm_idx" ON "notification_outbox" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_message_search_trgm_idx" ON "notification_outbox" USING gin ("message" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_cta_label_search_trgm_idx" ON "notification_outbox" USING gin ("cta_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_cta_url_search_trgm_idx" ON "notification_outbox" USING gin ("cta_url" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_status_search_trgm_idx" ON "notification_outbox" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notification_outbox_last_error_search_trgm_idx" ON "notification_outbox" USING gin ("last_error" gin_trgm_ops);--> statement-breakpoint
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
ALTER TABLE "activities" ADD CONSTRAINT "activities_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");--> statement-breakpoint
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");--> statement-breakpoint
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("norbital_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_project_id_projects_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("norbital_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_revision_of_quotes_fk" FOREIGN KEY ("revision_of") REFERENCES "quotes"("norbital_id");--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "agent_run_step" ADD CONSTRAINT "agent_run_step_774UFu3iuSmm_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_requested_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "document_asset" ADD CONSTRAINT "document_asset_owner_user_id_user_norbital_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_user_norbital_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_user_norbital_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_approval_request_id_approval_request_norbital_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("norbital_id");--> statement-breakpoint
ALTER TABLE "requestor" ADD CONSTRAINT "requestor_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_policy_id_policy_norbital_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("norbital_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_team_norbital_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("norbital_id");