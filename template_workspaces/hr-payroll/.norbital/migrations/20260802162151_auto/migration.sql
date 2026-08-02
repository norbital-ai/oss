ALTER TABLE "component_entries" ADD COLUMN "repayment_agreement_id" uuid GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'INSTALMENT' THEN (origin ->> 'agreement_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "component_entries_history" ADD COLUMN "repayment_agreement_id" uuid GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'INSTALMENT' THEN (origin ->> 'agreement_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "component_entries" ADD COLUMN "repayment_sequence" integer GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'INSTALMENT' THEN (origin ->> 'sequence')::integer END) STORED;
--> statement-breakpoint
ALTER TABLE "component_entries_history" ADD COLUMN "repayment_sequence" integer GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'INSTALMENT' THEN (origin ->> 'sequence')::integer END) STORED;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ADD COLUMN "component_entry_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'COMPONENT_ENTRY' THEN (source ->> 'entry_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources_history" ADD COLUMN "component_entry_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'COMPONENT_ENTRY' THEN (source ->> 'entry_id')::uuid END) STORED;
--> statement-breakpoint
CREATE INDEX "component_entries_repayment_agreement_id_index" ON "component_entries" ("repayment_agreement_id") WHERE "repayment_agreement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payslip_line_sources_component_entry_id_index" ON "payslip_line_sources" ("component_entry_id") WHERE "component_entry_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "component_entries" ADD CONSTRAINT "component_entries_repayment_agreement_id_repayment_agreements_fk" FOREIGN KEY ("repayment_agreement_id") REFERENCES "repayment_agreements"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ADD CONSTRAINT "payslip_line_sources_component_entry_id_component_entries_fk" FOREIGN KEY ("component_entry_id") REFERENCES "component_entries"("norbital_id");
