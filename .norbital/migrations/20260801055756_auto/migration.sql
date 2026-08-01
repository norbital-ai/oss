DROP TABLE "mutation_log";
--> statement-breakpoint
DROP TABLE IF EXISTS "mutation_log_history";
--> statement-breakpoint
DROP INDEX "document_asset_storage_provider_search_trgm_idx";
--> statement-breakpoint
DROP INDEX "document_asset_embedding_model_search_trgm_idx";
--> statement-breakpoint
ALTER TABLE "chat_session" DROP COLUMN "messages";
--> statement-breakpoint
ALTER TABLE "chat_session" DROP COLUMN "context";
--> statement-breakpoint
ALTER TABLE "document_asset" DROP COLUMN "storage_provider";
--> statement-breakpoint
ALTER TABLE "document_asset_history" DROP COLUMN "storage_provider";
--> statement-breakpoint
ALTER TABLE "document_asset" DROP COLUMN "metadata";
--> statement-breakpoint
ALTER TABLE "document_asset_history" DROP COLUMN "metadata";
--> statement-breakpoint
ALTER TABLE "document_asset" DROP COLUMN "embedding_model";
--> statement-breakpoint
ALTER TABLE "document_asset_history" DROP COLUMN "embedding_model";
--> statement-breakpoint
ALTER TABLE "accrual_bands" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "accrual_bands_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "accrual_bands" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "accrual_bands_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "companies_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "companies_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "company_holidays" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "company_holidays_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "company_holidays" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "company_holidays_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "component_entries" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "component_entries_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "component_entries" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "component_entries_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "component_types" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "component_types_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "component_types" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "component_types_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "contribution_rates" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "contribution_rates_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "contribution_rates" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "contribution_rates_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "contribution_treatments" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "contribution_treatments_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "contribution_treatments" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "contribution_treatments_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employees_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employees_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employment_terms" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employment_terms_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employment_terms" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employment_terms_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employments" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employments_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "employments" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "employments_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "jurisdictions" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "jurisdictions_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "jurisdictions" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "jurisdictions_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_ledger" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_ledger_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_ledger" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_ledger_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_requests_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_requests_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_types" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_types_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "leave_types" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "leave_types_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "overtime_limits" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "overtime_limits_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "overtime_limits" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "overtime_limits_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "overtime_rules" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "overtime_rules_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "overtime_rules" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "overtime_rules_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "pay_components" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "pay_components_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "pay_components" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "pay_components_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payroll_runs_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payroll_runs_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_contributions" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_contributions_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_contributions" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_contributions_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_line_sources" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_line_sources_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_lines" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_lines_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslip_lines" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslip_lines_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslips" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslips_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "payslips" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "payslips_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "repayment_agreements" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "repayment_agreements_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "repayment_agreements" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "repayment_agreements_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "roster_entries" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "roster_entries_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "roster_entries" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "roster_entries_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "shift_definitions" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "shift_definitions_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "shift_definitions" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "shift_definitions_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "statutory_contributions" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "statutory_contributions_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "statutory_contributions" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "statutory_contributions_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "time_entries" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "time_entries_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "time_entries" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "time_entries_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "approval_request" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "approval_request_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "approval_request" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "approval_request_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "automation_run_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "automation_run_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "automation_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "automation_run_history" ALTER COLUMN "automation_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_session" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "chat_session" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "chat_session" ALTER COLUMN "title" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_asset" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "document_asset_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "document_asset" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "document_asset_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "integration_outbox" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "integration_outbox_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "integration_outbox" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "integration_outbox_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "notification_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "notification_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "policy" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "policy_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "policy" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "policy_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "requestor" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "requestor_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "requestor" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "requestor_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "team" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "team_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "team" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "team_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "team" ALTER COLUMN "policy_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_history" ALTER COLUMN "policy_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "team_members_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "team_members" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "team_members_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "user_history" ALTER COLUMN "norbital_sys_period" SET DATA TYPE tstzrange USING "norbital_sys_period"::tstzrange;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "user_history" ALTER COLUMN "norbital_sys_period" SET DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)');
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'basic';
--> statement-breakpoint
ALTER TABLE "user_history" ALTER COLUMN "role" SET DEFAULT 'basic';
