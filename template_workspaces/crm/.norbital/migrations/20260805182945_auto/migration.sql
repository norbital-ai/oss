ALTER TABLE "accounts" ADD COLUMN "credit_limit" numeric;
--> statement-breakpoint
ALTER TABLE "accounts_history" ADD COLUMN "credit_limit" numeric;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credit_used" numeric;
--> statement-breakpoint
ALTER TABLE "accounts_history" ADD COLUMN "credit_used" numeric;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credit_hold" boolean;
--> statement-breakpoint
ALTER TABLE "accounts_history" ADD COLUMN "credit_hold" boolean;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "spec" text;
--> statement-breakpoint
ALTER TABLE "products_history" ADD COLUMN "spec" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_rate" numeric;
--> statement-breakpoint
ALTER TABLE "products_history" ADD COLUMN "tax_rate" numeric;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "qty_on_hand" numeric;
--> statement-breakpoint
ALTER TABLE "products_history" ADD COLUMN "qty_on_hand" numeric;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "main_supplier_id" uuid;
--> statement-breakpoint
ALTER TABLE "products_history" ADD COLUMN "main_supplier_id" uuid;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "payment_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "payment_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "shipping_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "shipping_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "place_of_loading" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "place_of_loading" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "place_of_delivery" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "place_of_delivery" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "packaging" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "packaging" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "shipping_mark" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "shipping_mark" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "time_of_shipment" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "time_of_shipment" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "other_terms" text;
--> statement-breakpoint
ALTER TABLE "quotes_history" ADD COLUMN "other_terms" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "contact" text;
--> statement-breakpoint
ALTER TABLE "suppliers_history" ADD COLUMN "contact" text;
--> statement-breakpoint
CREATE INDEX "products_spec_search_trgm_idx" ON "products" USING gin ("spec" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_payment_terms_search_trgm_idx" ON "quotes" USING gin ("payment_terms" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_shipping_terms_search_trgm_idx" ON "quotes" USING gin ("shipping_terms" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_place_of_loading_search_trgm_idx" ON "quotes" USING gin ("place_of_loading" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_place_of_delivery_search_trgm_idx" ON "quotes" USING gin ("place_of_delivery" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_packaging_search_trgm_idx" ON "quotes" USING gin ("packaging" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_shipping_mark_search_trgm_idx" ON "quotes" USING gin ("shipping_mark" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_time_of_shipment_search_trgm_idx" ON "quotes" USING gin ("time_of_shipment" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "quotes_other_terms_search_trgm_idx" ON "quotes" USING gin ("other_terms" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "suppliers_contact_search_trgm_idx" ON "suppliers" USING gin ("contact" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_main_supplier_id_suppliers_fk" FOREIGN KEY ("main_supplier_id") REFERENCES "suppliers"("norbital_id");
