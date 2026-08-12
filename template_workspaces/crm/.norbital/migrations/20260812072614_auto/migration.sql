CREATE TABLE "accounts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"external_code" text NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"website" text,
	"phone" text,
	"currency" text,
	"address" text,
	"credit_limit" numeric,
	"credit_used" numeric,
	"credit_hold" boolean,
	"active" boolean NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('accounts'::regclass, 'accounts_history');
--> statement-breakpoint
CREATE TABLE "activities" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
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
SELECT _norbital_create_history_table('activities'::regclass, 'activities_history');
--> statement-breakpoint
CREATE TABLE "contacts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
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
SELECT _norbital_create_history_table('contacts'::regclass, 'contacts_history');
--> statement-breakpoint
CREATE TABLE "contract_signings" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"quote_id" uuid NOT NULL,
	"variant" text,
	"status" text,
	"binding_hash" text NOT NULL,
	"generated_file" uuid,
	"counterparty_file" uuid,
	"share_token_hash" text,
	"share_expires_at" timestamp with time zone,
	"share_revoked_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"void_reason" text,
	"owner_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('contract_signings'::regclass, 'contract_signings_history');
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"quantity_received" numeric NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('goods_receipt_lines'::regclass, 'goods_receipt_lines_history');
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"doc_no" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"received_date" date,
	"note" text,
	"owner_id" uuid NOT NULL,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('goods_receipts'::regclass, 'goods_receipts_history');
--> statement-breakpoint
CREATE TABLE "products" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"external_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec" text,
	"unit" text,
	"unit_price" numeric,
	"tax_rate" numeric,
	"qty_on_hand" numeric,
	"main_supplier_id" uuid,
	"active" boolean NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('products'::regclass, 'products_history');
--> statement-breakpoint
CREATE TABLE "purchase_invoice_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"purchase_invoice_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit_cost" numeric NOT NULL,
	"tax_rate" numeric,
	"net" numeric,
	"tax" numeric,
	"line_total" numeric
);
--> statement-breakpoint
SELECT _norbital_create_history_table('purchase_invoice_lines'::regclass, 'purchase_invoice_lines_history');
--> statement-breakpoint
CREATE TABLE "purchase_invoices" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"doc_no" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_code" text NOT NULL,
	"supplier_name" text NOT NULL,
	"invoice_reference" text,
	"invoice_date" date,
	"status" text,
	"currency" text,
	"tax_inclusive" boolean NOT NULL,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('purchase_invoices'::regclass, 'purchase_invoices_history');
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"product_unit" text,
	"quantity" numeric NOT NULL,
	"unit_cost" numeric NOT NULL,
	"tax_rate" numeric,
	"net" numeric,
	"tax" numeric,
	"line_total" numeric
);
--> statement-breakpoint
SELECT _norbital_create_history_table('purchase_order_lines'::regclass, 'purchase_order_lines_history');
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"doc_no" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_code" text NOT NULL,
	"supplier_name" text NOT NULL,
	"status" text,
	"currency" text,
	"tax_inclusive" boolean NOT NULL,
	"expected_date" date,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('purchase_orders'::regclass, 'purchase_orders_history');
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
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
	"net" numeric,
	"tax" numeric,
	"line_total" numeric
);
--> statement-breakpoint
SELECT _norbital_create_history_table('quote_lines'::regclass, 'quote_lines_history');
--> statement-breakpoint
CREATE TABLE "quotes" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
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
	"payment_terms" text,
	"shipping_terms" text,
	"place_of_loading" text,
	"place_of_delivery" text,
	"packaging" text,
	"shipping_mark" text,
	"time_of_shipment" text,
	"other_terms" text,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"description" text,
	"revision_of" uuid,
	"revision_number" numeric,
	"confirmed_at" timestamp with time zone,
	"credit_acknowledged" boolean,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('quotes'::regclass, 'quotes_history');
--> statement-breakpoint
CREATE TABLE "sales_invoice_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"sales_invoice_id" uuid NOT NULL,
	"quote_line_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"product_unit" text,
	"quantity" numeric NOT NULL,
	"unit_price" numeric NOT NULL,
	"tax_rate" numeric,
	"net" numeric,
	"tax" numeric,
	"line_total" numeric
);
--> statement-breakpoint
SELECT _norbital_create_history_table('sales_invoice_lines'::regclass, 'sales_invoice_lines_history');
--> statement-breakpoint
CREATE TABLE "sales_invoices" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"doc_no" text NOT NULL,
	"quote_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text,
	"currency" text,
	"tax_inclusive" boolean NOT NULL,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"issued_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('sales_invoices'::regclass, 'sales_invoices_history');
--> statement-breakpoint
CREATE TABLE "settlements" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"regarding_type" text,
	"regarding_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text,
	"settled_on" date,
	"reference" text,
	"owner_id" uuid NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('settlements'::regclass, 'settlements_history');
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"external_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"category" text,
	"currency" text,
	"payment_terms_days" integer,
	"phone" text,
	"email" text,
	"address" text,
	"active" boolean NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('suppliers'::regclass, 'suppliers_history');
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
	"session_message_id" uuid,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('channel_inbound_message'::regclass, 'channel_inbound_message_history');
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
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"turns" jsonb DEFAULT '[]' NOT NULL,
	"usage_cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage_total_tokens" integer DEFAULT 0 NOT NULL,
	"usage_turns_counted" integer DEFAULT 0 NOT NULL,
	"usage_turns_unreported" integer DEFAULT 0 NOT NULL
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
	"avatar_asset_id" uuid,
	"status" text DEFAULT 'active',
	"role" text DEFAULT 'basic',
	"kind" text DEFAULT 'human',
	"channels" jsonb DEFAULT '[]'
);
--> statement-breakpoint
SELECT _norbital_create_history_table('user'::regclass, 'user_history');
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_external_code_index" ON "accounts" ("external_code");
--> statement-breakpoint
CREATE INDEX "accounts_name_search_trgm_idx" ON "accounts" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "activities_regarding_type_regarding_id_index" ON "activities" ("regarding_type","regarding_id");
--> statement-breakpoint
CREATE INDEX "activities_owner_id_index" ON "activities" ("owner_id");
--> statement-breakpoint
CREATE INDEX "activities_due_date_index" ON "activities" ("due_date");
--> statement-breakpoint
CREATE INDEX "activities_subject_search_trgm_idx" ON "activities" USING gin ("subject" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contacts_account_id_index" ON "contacts" ("account_id");
--> statement-breakpoint
CREATE INDEX "contacts_first_name_search_trgm_idx" ON "contacts" USING gin ("first_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contacts_last_name_search_trgm_idx" ON "contacts" USING gin ("last_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contract_signings_quote_id_index" ON "contract_signings" ("quote_id");
--> statement-breakpoint
CREATE INDEX "contract_signings_status_index" ON "contract_signings" ("status");
--> statement-breakpoint
CREATE INDEX "contract_signings_binding_hash_search_trgm_idx" ON "contract_signings" USING gin ("binding_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_goods_receipt_id_index" ON "goods_receipt_lines" ("goods_receipt_id");
--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_purchase_order_line_id_index" ON "goods_receipt_lines" ("purchase_order_line_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_doc_no_index" ON "goods_receipts" ("doc_no");
--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_order_id_index" ON "goods_receipts" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX "goods_receipts_owner_id_index" ON "goods_receipts" ("owner_id");
--> statement-breakpoint
CREATE INDEX "goods_receipts_doc_no_search_trgm_idx" ON "goods_receipts" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "products_external_code_index" ON "products" ("external_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_index" ON "products" ("code");
--> statement-breakpoint
CREATE INDEX "products_name_search_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_purchase_invoice_id_index" ON "purchase_invoice_lines" ("purchase_invoice_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_purchase_order_line_id_index" ON "purchase_invoice_lines" ("purchase_order_line_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_product_name_search_trgm_idx" ON "purchase_invoice_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_invoices_doc_no_index" ON "purchase_invoices" ("doc_no");
--> statement-breakpoint
CREATE INDEX "purchase_invoices_purchase_order_id_index" ON "purchase_invoices" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoices_supplier_id_index" ON "purchase_invoices" ("supplier_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoices_status_index" ON "purchase_invoices" ("status");
--> statement-breakpoint
CREATE INDEX "purchase_invoices_doc_no_search_trgm_idx" ON "purchase_invoices" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_purchase_order_id_index" ON "purchase_order_lines" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_id_index" ON "purchase_order_lines" ("product_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_name_search_trgm_idx" ON "purchase_order_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_doc_no_index" ON "purchase_orders" ("doc_no");
--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_id_index" ON "purchase_orders" ("supplier_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_status_index" ON "purchase_orders" ("status");
--> statement-breakpoint
CREATE INDEX "purchase_orders_owner_id_index" ON "purchase_orders" ("owner_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_expected_date_index" ON "purchase_orders" ("expected_date");
--> statement-breakpoint
CREATE INDEX "purchase_orders_doc_no_search_trgm_idx" ON "purchase_orders" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quote_lines_quote_id_index" ON "quote_lines" ("quote_id");
--> statement-breakpoint
CREATE INDEX "quote_lines_product_id_index" ON "quote_lines" ("product_id");
--> statement-breakpoint
CREATE INDEX "quote_lines_product_name_search_trgm_idx" ON "quote_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_doc_no_index" ON "quotes" ("doc_no");
--> statement-breakpoint
CREATE INDEX "quotes_account_id_index" ON "quotes" ("account_id");
--> statement-breakpoint
CREATE INDEX "quotes_owner_id_index" ON "quotes" ("owner_id");
--> statement-breakpoint
CREATE INDEX "quotes_status_index" ON "quotes" ("status");
--> statement-breakpoint
CREATE INDEX "quotes_revision_of_index" ON "quotes" ("revision_of");
--> statement-breakpoint
CREATE INDEX "quotes_doc_no_search_trgm_idx" ON "quotes" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_sales_invoice_id_index" ON "sales_invoice_lines" ("sales_invoice_id");
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_quote_line_id_index" ON "sales_invoice_lines" ("quote_line_id");
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_product_name_search_trgm_idx" ON "sales_invoice_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_doc_no_index" ON "sales_invoices" ("doc_no");
--> statement-breakpoint
CREATE INDEX "sales_invoices_quote_id_index" ON "sales_invoices" ("quote_id");
--> statement-breakpoint
CREATE INDEX "sales_invoices_account_id_index" ON "sales_invoices" ("account_id");
--> statement-breakpoint
CREATE INDEX "sales_invoices_status_index" ON "sales_invoices" ("status");
--> statement-breakpoint
CREATE INDEX "sales_invoices_doc_no_search_trgm_idx" ON "sales_invoices" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "settlements_regarding_id_index" ON "settlements" ("regarding_id");
--> statement-breakpoint
CREATE INDEX "settlements_regarding_type_index" ON "settlements" ("regarding_type");
--> statement-breakpoint
CREATE INDEX "settlements_reference_search_trgm_idx" ON "settlements" USING gin ("reference" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_external_code_index" ON "suppliers" ("external_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_index" ON "suppliers" ("code");
--> statement-breakpoint
CREATE INDEX "suppliers_name_index" ON "suppliers" ("name");
--> statement-breakpoint
CREATE INDEX "suppliers_active_index" ON "suppliers" ("active");
--> statement-breakpoint
CREATE INDEX "suppliers_name_search_trgm_idx" ON "suppliers" USING gin ("name" gin_trgm_ops);
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
CREATE INDEX "chat_session_title_search_trgm_idx" ON "chat_session" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_platform_search_trgm_idx" ON "chat_session" USING gin ("platform" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_visibility_search_trgm_idx" ON "chat_session" USING gin ("visibility" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_external_thread_id_search_trgm_idx" ON "chat_session" USING gin ("external_thread_id" gin_trgm_ops);
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
CREATE INDEX "user_status_search_trgm_idx" ON "user" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_role_search_trgm_idx" ON "user" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_kind_search_trgm_idx" ON "user" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "contract_signings" ADD CONSTRAINT "contract_signings_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");
--> statement-breakpoint
ALTER TABLE "contract_signings" ADD CONSTRAINT "contract_signings_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines"("norbital_id");
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("norbital_id");
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_main_supplier_id_suppliers_fk" FOREIGN KEY ("main_supplier_id") REFERENCES "suppliers"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_purchase_invoice_id_purchase_invoices_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_purchase_order_line_id_purchase_order_lines_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_purchase_order_id_purchase_orders_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_suppliers_fk" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_fk" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_revision_of_quotes_fk" FOREIGN KEY ("revision_of") REFERENCES "quotes"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_sales_invoice_id_sales_invoices_fk" FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_quote_line_id_quote_lines_fk" FOREIGN KEY ("quote_line_id") REFERENCES "quote_lines"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_requested_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_X3p24605t0lh_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversation"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_automation_run_id_automation_run_norbital_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");
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
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_avatar_asset_id_document_asset_norbital_id_fkey" FOREIGN KEY ("avatar_asset_id") REFERENCES "document_asset"("norbital_id") ON DELETE SET NULL;
