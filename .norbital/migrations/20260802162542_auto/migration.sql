ALTER TABLE "payslip_line_sources" ADD COLUMN "time_entry_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'TIME_ENTRY' THEN (source ->> 'time_entry_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources_history" ADD COLUMN "time_entry_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'TIME_ENTRY' THEN (source ->> 'time_entry_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ADD COLUMN "leave_request_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'LEAVE_REQUEST' THEN (source ->> 'leave_request_id')::uuid END) STORED;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources_history" ADD COLUMN "leave_request_id" uuid GENERATED ALWAYS AS (CASE WHEN source ->> 'kind' = 'LEAVE_REQUEST' THEN (source ->> 'leave_request_id')::uuid END) STORED;
--> statement-breakpoint
CREATE INDEX "payslip_line_sources_time_entry_id_index" ON "payslip_line_sources" ("time_entry_id") WHERE "time_entry_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payslip_line_sources_leave_request_id_index" ON "payslip_line_sources" ("leave_request_id") WHERE "leave_request_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ADD CONSTRAINT "payslip_line_sources_time_entry_id_time_entries_fk" FOREIGN KEY ("time_entry_id") REFERENCES "time_entries"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ADD CONSTRAINT "payslip_line_sources_leave_request_id_leave_requests_fk" FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("norbital_id");
