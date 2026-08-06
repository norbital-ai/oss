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
ALTER TABLE "quotes" ADD COLUMN "credit_acknowledged" boolean;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "credit_acknowledged" boolean;
--> statement-breakpoint
CREATE INDEX "contract_signings_quote_id_index" ON "contract_signings" ("quote_id");
--> statement-breakpoint
CREATE INDEX "contract_signings_status_index" ON "contract_signings" ("status");
--> statement-breakpoint
CREATE INDEX "contract_signings_variant_search_trgm_idx" ON "contract_signings" USING gin ("variant" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contract_signings_status_search_trgm_idx" ON "contract_signings" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contract_signings_binding_hash_search_trgm_idx" ON "contract_signings" USING gin ("binding_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contract_signings_share_token_hash_search_trgm_idx" ON "contract_signings" USING gin ("share_token_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "contract_signings_void_reason_search_trgm_idx" ON "contract_signings" USING gin ("void_reason" gin_trgm_ops);
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
CREATE INDEX "goods_receipts_note_search_trgm_idx" ON "goods_receipts" USING gin ("note" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_purchase_invoice_id_index" ON "purchase_invoice_lines" ("purchase_invoice_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_purchase_order_line_id_index" ON "purchase_invoice_lines" ("purchase_order_line_id");
--> statement-breakpoint
CREATE INDEX "purchase_invoice_lines_product_code_search_trgm_idx" ON "purchase_invoice_lines" USING gin ("product_code" gin_trgm_ops);
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
CREATE INDEX "purchase_invoices_supplier_code_search_trgm_idx" ON "purchase_invoices" USING gin ("supplier_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoices_supplier_name_search_trgm_idx" ON "purchase_invoices" USING gin ("supplier_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoices_invoice_reference_search_trgm_idx" ON "purchase_invoices" USING gin ("invoice_reference" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoices_status_search_trgm_idx" ON "purchase_invoices" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoices_currency_search_trgm_idx" ON "purchase_invoices" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "purchase_invoices_cancel_reason_search_trgm_idx" ON "purchase_invoices" USING gin ("cancel_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_sales_invoice_id_index" ON "sales_invoice_lines" ("sales_invoice_id");
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_quote_line_id_index" ON "sales_invoice_lines" ("quote_line_id");
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_product_code_search_trgm_idx" ON "sales_invoice_lines" USING gin ("product_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_product_name_search_trgm_idx" ON "sales_invoice_lines" USING gin ("product_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_product_unit_search_trgm_idx" ON "sales_invoice_lines" USING gin ("product_unit" gin_trgm_ops);
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
CREATE INDEX "sales_invoices_status_search_trgm_idx" ON "sales_invoices" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoices_currency_search_trgm_idx" ON "sales_invoices" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "sales_invoices_cancel_reason_search_trgm_idx" ON "sales_invoices" USING gin ("cancel_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "settlements_regarding_id_index" ON "settlements" ("regarding_id");
--> statement-breakpoint
CREATE INDEX "settlements_regarding_type_index" ON "settlements" ("regarding_type");
--> statement-breakpoint
CREATE INDEX "settlements_regarding_type_search_trgm_idx" ON "settlements" USING gin ("regarding_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "settlements_currency_search_trgm_idx" ON "settlements" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "settlements_reference_search_trgm_idx" ON "settlements" USING gin ("reference" gin_trgm_ops);
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
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_sales_invoice_id_sales_invoices_fk" FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_quote_line_id_quote_lines_fk" FOREIGN KEY ("quote_line_id") REFERENCES "quote_lines"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_quote_id_quotes_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_account_id_accounts_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("norbital_id");
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_owner_id_user_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");
