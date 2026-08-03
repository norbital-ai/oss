DROP TABLE IF EXISTS "chat_message_history";
--> statement-breakpoint
DROP TABLE IF EXISTS "chat_session_history";
--> statement-breakpoint
DROP TABLE IF EXISTS "chat_turn_history";
--> statement-breakpoint
CREATE TABLE "external_synced_table" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"collection_name" text NOT NULL,
	"record_id" uuid,
	"external_system" text NOT NULL,
	"external_code" text NOT NULL,
	"external_id" text,
	"sync_direction" text,
	"sync_state" text,
	"payload_hash" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('external_synced_table'::regclass, 'external_synced_table_history');
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"invoice_id" uuid NOT NULL,
	"quote_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
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
SELECT _norbital_create_history_table('invoice_lines'::regclass, 'invoice_lines_history');
--> statement-breakpoint
CREATE TABLE "invoices" (
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
	"issue_date" date,
	"due_date" date,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"issued_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('invoices'::regclass, 'invoices_history');
--> statement-breakpoint
CREATE TABLE "pricing_settings" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"scope" text NOT NULL,
	"markup_pct" numeric NOT NULL,
	"effective_from" date,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('pricing_settings'::regclass, 'pricing_settings_history');
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
	"product_spec" text,
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
	"warehouse_id" uuid,
	"payment_terms_days" integer,
	"net" numeric,
	"tax" numeric,
	"gross" numeric,
	"owner_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('purchase_orders'::regclass, 'purchase_orders_history');
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"product_id" uuid NOT NULL,
	"qty_on_hand" numeric,
	"unit_cost" numeric,
	"stock_unit" text,
	"qty_as_of" timestamp with time zone,
	"cost_as_of" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('stock_levels'::regclass, 'stock_levels_history');
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"lot_no" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit" text,
	"sellable" boolean NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('stock_lots'::regclass, 'stock_lots_history');
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"search_alias" text,
	"category" text,
	"currency" text,
	"payment_terms_days" integer,
	"contact_name" text,
	"phone" text,
	"email" text,
	"address" text,
	"active" boolean NOT NULL,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('suppliers'::regclass, 'suppliers_history');
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"active" boolean NOT NULL,
	"notes" text
);
--> statement-breakpoint
SELECT _norbital_create_history_table('warehouses'::regclass, 'warehouses_history');
--> statement-breakpoint
DROP INDEX "products_mfi_search_trgm_idx";
--> statement-breakpoint
DROP INDEX "products_density_search_trgm_idx";
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN "direction" text;
--> statement-breakpoint
ALTER TABLE "payment_records_history" ADD COLUMN "direction" text;
--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN "purchase_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "payment_records_history" ADD COLUMN "purchase_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "net" numeric;
--> statement-breakpoint
ALTER TABLE "quote_lines_history" ADD COLUMN "net" numeric;
--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "tax" numeric;
--> statement-breakpoint
ALTER TABLE "quote_lines_history" ADD COLUMN "tax" numeric;
--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "below_floor" boolean;
--> statement-breakpoint
ALTER TABLE "quote_lines_history" ADD COLUMN "below_floor" boolean;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "trade" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "trade" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "warehouse_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "warehouse_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "logistics_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "logistics_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "payment_terms_days" integer;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "payment_terms_days" integer;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "shipping_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "shipping_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "cancel_reason" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "cancel_reason" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "replaces_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "replaces_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_cost_usd" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_total_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_turns_counted" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "usage_turns_unreported" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_turn" ADD COLUMN "usage_settled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "mfi";
--> statement-breakpoint
ALTER TABLE "products_history" DROP COLUMN "mfi";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "density";
--> statement-breakpoint
ALTER TABLE "products_history" DROP COLUMN "density";
--> statement-breakpoint
ALTER TABLE "payment_records" ALTER COLUMN "quote_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_records_history" ALTER COLUMN "quote_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "external_synced_table_external_system_collection_name_external_code_index" ON "external_synced_table" ("external_system","collection_name","external_code");
--> statement-breakpoint
CREATE INDEX "external_synced_table_record_id_index" ON "external_synced_table" ("record_id");
--> statement-breakpoint
CREATE INDEX "external_synced_table_collection_name_index" ON "external_synced_table" ("collection_name");
--> statement-breakpoint
CREATE INDEX "external_synced_table_sync_state_index" ON "external_synced_table" ("sync_state");
--> statement-breakpoint
CREATE INDEX "external_synced_table_collection_name_search_trgm_idx" ON "external_synced_table" USING gin ("collection_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_external_system_search_trgm_idx" ON "external_synced_table" USING gin ("external_system" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_external_code_search_trgm_idx" ON "external_synced_table" USING gin ("external_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_external_id_search_trgm_idx" ON "external_synced_table" USING gin ("external_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_sync_direction_search_trgm_idx" ON "external_synced_table" USING gin ("sync_direction" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_sync_state_search_trgm_idx" ON "external_synced_table" USING gin ("sync_state" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_payload_hash_search_trgm_idx" ON "external_synced_table" USING gin ("payload_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "external_synced_table_last_error_search_trgm_idx" ON "external_synced_table" USING gin ("last_error" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_id_index" ON "invoice_lines" ("invoice_id");
--> statement-breakpoint
CREATE INDEX "invoice_lines_quote_line_id_index" ON "invoice_lines" ("quote_line_id");
--> statement-breakpoint
CREATE INDEX "invoice_lines_product_id_index" ON "invoice_lines" ("product_id");
--> statement-breakpoint
CREATE INDEX "invoice_lines_product_code_search_trgm_idx" ON "invoice_lines" USING gin ("product_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoice_lines_product_name_search_trgm_idx" ON "invoice_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoice_lines_product_unit_search_trgm_idx" ON "invoice_lines" USING gin ("product_unit" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_doc_no_index" ON "invoices" ("doc_no");
--> statement-breakpoint
CREATE INDEX "invoices_quote_id_index" ON "invoices" ("quote_id");
--> statement-breakpoint
CREATE INDEX "invoices_account_id_index" ON "invoices" ("account_id");
--> statement-breakpoint
CREATE INDEX "invoices_status_index" ON "invoices" ("status");
--> statement-breakpoint
CREATE INDEX "invoices_owner_id_index" ON "invoices" ("owner_id");
--> statement-breakpoint
CREATE INDEX "invoices_doc_no_search_trgm_idx" ON "invoices" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoices_status_search_trgm_idx" ON "invoices" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoices_currency_search_trgm_idx" ON "invoices" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoices_cancel_reason_search_trgm_idx" ON "invoices" USING gin ("cancel_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invoices_notes_search_trgm_idx" ON "invoices" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payment_records_purchase_order_id_index" ON "payment_records" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX "payment_records_direction_index" ON "payment_records" ("direction");
--> statement-breakpoint
CREATE INDEX "payment_records_direction_search_trgm_idx" ON "payment_records" USING gin ("direction" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_settings_scope_index" ON "pricing_settings" ("scope");
--> statement-breakpoint
CREATE INDEX "pricing_settings_scope_search_trgm_idx" ON "pricing_settings" USING gin ("scope" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "pricing_settings_notes_search_trgm_idx" ON "pricing_settings" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_purchase_order_id_index" ON "purchase_order_lines" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_id_index" ON "purchase_order_lines" ("product_id");
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_code_search_trgm_idx" ON "purchase_order_lines" USING gin ("product_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_name_search_trgm_idx" ON "purchase_order_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_spec_search_trgm_idx" ON "purchase_order_lines" USING gin ("product_spec" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_unit_search_trgm_idx" ON "purchase_order_lines" USING gin ("product_unit" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_doc_no_index" ON "purchase_orders" ("doc_no");
--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_id_index" ON "purchase_orders" ("supplier_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_status_index" ON "purchase_orders" ("status");
--> statement-breakpoint
CREATE INDEX "purchase_orders_owner_id_index" ON "purchase_orders" ("owner_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_id_index" ON "purchase_orders" ("warehouse_id");
--> statement-breakpoint
CREATE INDEX "purchase_orders_expected_date_index" ON "purchase_orders" ("expected_date");
--> statement-breakpoint
CREATE INDEX "purchase_orders_doc_no_search_trgm_idx" ON "purchase_orders" USING gin ("doc_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_code_search_trgm_idx" ON "purchase_orders" USING gin ("supplier_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_name_search_trgm_idx" ON "purchase_orders" USING gin ("supplier_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_status_search_trgm_idx" ON "purchase_orders" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_currency_search_trgm_idx" ON "purchase_orders" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_cancel_reason_search_trgm_idx" ON "purchase_orders" USING gin ("cancel_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_orders_notes_search_trgm_idx" ON "purchase_orders" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quote_lines_below_floor_index" ON "quote_lines" ("below_floor");
--> statement-breakpoint
CREATE INDEX "quotes_warehouse_id_index" ON "quotes" ("warehouse_id");
--> statement-breakpoint
CREATE INDEX "quotes_replaces_id_index" ON "quotes" ("replaces_id");
--> statement-breakpoint
CREATE INDEX "quotes_trade_search_trgm_idx" ON "quotes" USING gin ("trade" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_shipping_terms_search_trgm_idx" ON "quotes" USING gin ("shipping_terms" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_cancel_reason_search_trgm_idx" ON "quotes" USING gin ("cancel_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_product_id_index" ON "stock_levels" ("product_id");
--> statement-breakpoint
CREATE INDEX "stock_levels_stock_unit_search_trgm_idx" ON "stock_levels" USING gin ("stock_unit" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_lots_product_id_warehouse_id_lot_no_index" ON "stock_lots" ("product_id","warehouse_id","lot_no");
--> statement-breakpoint
CREATE INDEX "stock_lots_product_id_index" ON "stock_lots" ("product_id");
--> statement-breakpoint
CREATE INDEX "stock_lots_warehouse_id_index" ON "stock_lots" ("warehouse_id");
--> statement-breakpoint
CREATE INDEX "stock_lots_sellable_index" ON "stock_lots" ("sellable");
--> statement-breakpoint
CREATE INDEX "stock_lots_lot_no_search_trgm_idx" ON "stock_lots" USING gin ("lot_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "stock_lots_unit_search_trgm_idx" ON "stock_lots" USING gin ("unit" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_index" ON "suppliers" ("code");
--> statement-breakpoint
CREATE INDEX "suppliers_name_index" ON "suppliers" ("name");
--> statement-breakpoint
CREATE INDEX "suppliers_active_index" ON "suppliers" ("active");
--> statement-breakpoint
CREATE INDEX "suppliers_code_search_trgm_idx" ON "suppliers" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_name_search_trgm_idx" ON "suppliers" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_search_alias_search_trgm_idx" ON "suppliers" USING gin ("search_alias" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_category_search_trgm_idx" ON "suppliers" USING gin ("category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_currency_search_trgm_idx" ON "suppliers" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_contact_name_search_trgm_idx" ON "suppliers" USING gin ("contact_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_phone_search_trgm_idx" ON "suppliers" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_email_search_trgm_idx" ON "suppliers" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_address_search_trgm_idx" ON "suppliers" USING gin ("address" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_notes_search_trgm_idx" ON "suppliers" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_code_index" ON "warehouses" ("code");
--> statement-breakpoint
CREATE INDEX "warehouses_active_index" ON "warehouses" ("active");
--> statement-breakpoint
CREATE INDEX "warehouses_code_search_trgm_idx" ON "warehouses" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "warehouses_name_search_trgm_idx" ON "warehouses" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "warehouses_address_search_trgm_idx" ON "warehouses" USING gin ("address" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "warehouses_phone_search_trgm_idx" ON "warehouses" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "warehouses_notes_search_trgm_idx" ON "warehouses" USING gin ("notes" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quote_line_id_quote_lines_fk" FOREIGN KEY ("quote_line_id") REFERENCES "quote_lines"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_purchase_order_id_purchase_orders_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_fk" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_fk" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("norbital_id");
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_warehouse_id_warehouses_fk" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("norbital_id");
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_logistics_owner_id_user_fk" FOREIGN KEY ("logistics_owner_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_products_fk" FOREIGN KEY ("product_id") REFERENCES "products"("norbital_id");
--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_warehouse_id_warehouses_fk" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("norbital_id");
