CREATE TABLE "companies" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registration_number" text NOT NULL,
	"pay_cutoff_day" integer NOT NULL,
	"pay_day" integer NOT NULL,
	"leave_year_start_month" integer NOT NULL,
	"overtime_calculation_method" text DEFAULT 'STATUTORY_AGGREGATE' NOT NULL,
	"settlement_policy" jsonb,
	"risk_class" text,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('companies'::regclass, 'companies_history');
--> statement-breakpoint
CREATE TABLE "company_holidays" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"substitutes_date" date,
	"name" text NOT NULL,
	"scope" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('company_holidays'::regclass, 'company_holidays_history');
--> statement-breakpoint
CREATE TABLE "component_entries" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"pay_component_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"quantity" numeric,
	"event_date" date NOT NULL,
	"pay_period" text,
	"description" text,
	"origin" jsonb NOT NULL,
	"usage_mode" text GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'RECURRING' THEN 'RECURRING' ELSE 'SINGLE_USE' END) STORED,
	"repayment_agreement_id" uuid GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'LOAN_INSTALMENT' THEN (origin ->> 'agreement_id')::uuid END) STORED,
	"repayment_sequence" integer GENERATED ALWAYS AS (CASE WHEN origin ->> 'kind' = 'LOAN_INSTALMENT' THEN (origin ->> 'sequence')::integer END) STORED
);
--> statement-breakpoint
SELECT _norbital_create_history_table('component_entries'::regclass, 'component_entries_history');
--> statement-breakpoint
CREATE TABLE "contribution_rates" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"statutory_contribution_id" uuid NOT NULL,
	"selector" jsonb NOT NULL,
	"award" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('contribution_rates'::regclass, 'contribution_rates_history');
--> statement-breakpoint
CREATE TABLE "employees" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"name" text NOT NULL,
	"date_of_birth" date,
	"gender" text,
	"marital_status" text,
	"spouse_status" text,
	"nationality" text,
	"identity_number" text,
	"dependents_count" integer DEFAULT 0 NOT NULL,
	"email" text,
	"phone" text,
	"address" jsonb,
	"user_id" uuid
);
--> statement-breakpoint
SELECT _norbital_create_history_table('employees'::regclass, 'employees_history');
--> statement-breakpoint
CREATE TABLE "employment_statutory_facts" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"statutory_contribution_id" uuid NOT NULL,
	"status" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('employment_statutory_facts'::regclass, 'employment_statutory_facts_history');
--> statement-breakpoint
CREATE TABLE "employment_terms" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"base_salary" jsonb NOT NULL,
	"pay_frequency" text NOT NULL,
	"ordinary_hours_per_week" numeric NOT NULL,
	"working_days_per_week" numeric NOT NULL,
	"work_classification" text NOT NULL,
	"statutory_work_category" text DEFAULT 'NON_MANUAL' NOT NULL,
	"employment_type" text NOT NULL,
	"overtime_eligible" boolean NOT NULL,
	"department" text,
	"job_title" text,
	"payroll_group" text,
	"rest_day" text NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('employment_terms'::regclass, 'employment_terms_history');
--> statement-breakpoint
CREATE TABLE "employments" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employee_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_number" text NOT NULL,
	"hire_date" date NOT NULL,
	"exit_date" date,
	"exit_reason" text,
	"bank" jsonb,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('employments'::regclass, 'employments_history');
--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"tax_year_start_month" integer NOT NULL,
	"leave_year_start_month" integer NOT NULL,
	"proration" jsonb NOT NULL,
	"rounding" text NOT NULL,
	"ordinary_rate_basis" text NOT NULL,
	"ordinary_rate_divisor" numeric NOT NULL,
	"effective_range" jsonb NOT NULL,
	"definition_hash" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('jurisdictions'::regclass, 'jurisdictions_history');
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"kind" text GENERATED ALWAYS AS (event ->> 'kind') STORED,
	"from_date" date GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN norbital_date(event ->> 'from_date') ELSE norbital_date(event ->> 'effective_on') END) STORED,
	"to_date" date GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN norbital_date(event ->> 'to_date') ELSE norbital_date(event ->> 'effective_on') END) STORED,
	"days" numeric GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'days')::numeric ELSE (event ->> 'movement_days')::numeric END) STORED,
	"half_day_start" boolean GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'half_day_start')::boolean ELSE false END) STORED,
	"half_day_end" boolean GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'half_day_end')::boolean ELSE false END) STORED,
	"reason" text GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN event ->> 'reason' ELSE event ->> 'note' END) STORED,
	"certificate_file" uuid GENERATED ALWAYS AS (CASE WHEN event ->> 'kind' = 'TIME_OFF' AND NULLIF(event ->> 'certificate_file', '') IS NOT NULL THEN (event ->> 'certificate_file')::uuid END) STORED
);
--> statement-breakpoint
SELECT _norbital_create_history_table('leave_requests'::regclass, 'leave_requests_history');
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"eligibility" jsonb NOT NULL,
	"aggregates_with" text,
	"encash_on_exit" boolean NOT NULL,
	"requires_certificate_after_days" integer,
	"accrual" jsonb NOT NULL,
	"entitlement" jsonb NOT NULL,
	"payroll_effect" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('leave_types'::regclass, 'leave_types_history');
--> statement-breakpoint
CREATE TABLE "overtime_limits" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"period" text NOT NULL,
	"max_hours" numeric NOT NULL,
	"on_exceed" text NOT NULL,
	"authority" text NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('overtime_limits'::regclass, 'overtime_limits_history');
--> statement-breakpoint
CREATE TABLE "overtime_rules" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"day_type" text NOT NULL,
	"authority" text NOT NULL,
	"band" jsonb NOT NULL,
	"award" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('overtime_rules'::regclass, 'overtime_rules_history');
--> statement-breakpoint
CREATE TABLE "pay_components" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"policy" jsonb NOT NULL,
	"nature" text GENERATED ALWAYS AS (policy ->> 'kind') STORED,
	"sequence" integer NOT NULL,
	"eligibility" jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('pay_components'::regclass, 'pay_components_history');
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"lifecycle" text NOT NULL,
	"configuration_hash" text NOT NULL,
	"configuration_snapshot" jsonb NOT NULL,
	"pay_date" date NOT NULL,
	"attendance_from" date NOT NULL,
	"attendance_to" date NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('payroll_runs'::regclass, 'payroll_runs_history');
--> statement-breakpoint
CREATE TABLE "payslip_lines" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"payslip_id" uuid NOT NULL,
	"component" jsonb NOT NULL,
	"pay_component_id" uuid GENERATED ALWAYS AS (CASE WHEN component ? 'pay_component_id' THEN (component ->> 'pay_component_id')::uuid END) STORED,
	"component_entry_id" uuid GENERATED ALWAYS AS (CASE WHEN component ->> 'kind' IN ('COMPONENT_ENTRY_ONCE', 'COMPONENT_ENTRY_RECURRING') THEN (component ->> 'component_entry_id')::uuid END) STORED,
	"component_entry_usage" text GENERATED ALWAYS AS (CASE WHEN component ->> 'kind' = 'COMPONENT_ENTRY_ONCE' THEN 'SINGLE_USE' WHEN component ->> 'kind' = 'COMPONENT_ENTRY_RECURRING' THEN 'RECURRING' END) STORED,
	"statutory_contribution_id" uuid GENERATED ALWAYS AS (CASE WHEN component ->> 'kind' IN ('STATUTORY_EMPLOYEE', 'STATUTORY_EMPLOYER') THEN (component ->> 'statutory_contribution_id')::uuid END) STORED,
	"bucket" text NOT NULL,
	"amount" numeric NOT NULL,
	"quantity" numeric,
	"rate" numeric,
	"sequence" integer NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('payslip_lines'::regclass, 'payslip_lines_history');
--> statement-breakpoint
CREATE TABLE "payslips" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"payroll_run_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"gross" numeric NOT NULL,
	"total_deductions" numeric NOT NULL,
	"net" numeric NOT NULL,
	"employer_cost" numeric NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('payslips'::regclass, 'payslips_history');
--> statement-breakpoint
CREATE TABLE "repayment_agreements" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"pay_component_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"principal" numeric NOT NULL,
	"disbursed_on" date,
	"repay_by" date NOT NULL,
	"schedule" jsonb NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('repayment_agreements'::regclass, 'repayment_agreements_history');
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"shift_definition_id" uuid NOT NULL,
	"assignment_code" text,
	"designation" text NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('roster_entries'::regclass, 'roster_entries_history');
--> statement-breakpoint
CREATE TABLE "shift_definitions" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"break_minutes" integer NOT NULL,
	"crosses_midnight" boolean NOT NULL,
	"pays_overtime" boolean DEFAULT true NOT NULL,
	"overtime_break_minutes" integer DEFAULT 0 NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('shift_definitions'::regclass, 'shift_definitions_history');
--> statement-breakpoint
CREATE TABLE "statutory_contributions" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"authority" text NOT NULL,
	"payer" text NOT NULL,
	"keyed_by" text NOT NULL,
	"rounding" text NOT NULL,
	"relief_for" uuid[] NOT NULL,
	"sequence" integer NOT NULL,
	"special_rules" text[] NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('statutory_contributions'::regclass, 'statutory_contributions_history');
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"employment_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"clock_in" timestamp with time zone,
	"clock_out" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"overtime_authorized" boolean,
	"approved_ot_1x_hours" numeric,
	"approved_ot_15x_hours" numeric,
	"approved_ot_2x_hours" numeric,
	"approved_ot_3x_hours" numeric,
	"approved_ot_flat_hours" numeric,
	"overtime_in" timestamp with time zone,
	"overtime_out" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('time_entries'::regclass, 'time_entries_history');
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
	"chat_message_id" uuid,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('channel_inbound_message'::regclass, 'channel_inbound_message_history');
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"chat_id" uuid NOT NULL,
	"turn_id" uuid,
	"role" text NOT NULL,
	"seq" integer NOT NULL,
	"parts" jsonb,
	"model" text,
	"usage" jsonb,
	"plan_mode" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"queue_status" text DEFAULT 'live' NOT NULL,
	"release_mode" text,
	"author_user_id" uuid,
	"author_display_name" text,
	"source_provider" text,
	"source_conversation_id" text,
	"source_message_id" text,
	"source_deleted_at" timestamp with time zone
);
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
	"usage_cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage_total_tokens" integer DEFAULT 0 NOT NULL,
	"usage_turns_counted" integer DEFAULT 0 NOT NULL,
	"usage_turns_unreported" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_turn" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"chat_id" uuid NOT NULL,
	"prompt_message_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text NOT NULL,
	"parent_turn_id" uuid,
	"subagent_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"usage_settled_at" timestamp with time zone
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
	"avatar_url" text,
	"status" text DEFAULT 'active',
	"role" text DEFAULT 'basic',
	"kind" text DEFAULT 'human',
	"channels" jsonb DEFAULT '[]'
);
--> statement-breakpoint
SELECT _norbital_create_history_table('user'::regclass, 'user_history');
--> statement-breakpoint
CREATE INDEX "companies_name_search_trgm_idx" ON "companies" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "companies_registration_number_search_trgm_idx" ON "companies" USING gin ("registration_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "companies_overtime_calculation_method_search_trgm_idx" ON "companies" USING gin ("overtime_calculation_method" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "companies_risk_class_search_trgm_idx" ON "companies" USING gin ("risk_class" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "company_holidays_name_search_trgm_idx" ON "company_holidays" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "component_entries_norbital_id_pay_component_id_usage_mode_index" ON "component_entries" ("norbital_id","pay_component_id","usage_mode");
--> statement-breakpoint
CREATE INDEX "component_entries_employment_id_pay_period_index" ON "component_entries" ("employment_id","pay_period");
--> statement-breakpoint
CREATE INDEX "component_entries_pay_component_id_index" ON "component_entries" ("pay_component_id");
--> statement-breakpoint
CREATE INDEX "component_entries_repayment_agreement_id_index" ON "component_entries" ("repayment_agreement_id") WHERE "repayment_agreement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "component_entries_pay_period_search_trgm_idx" ON "component_entries" USING gin ("pay_period" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "component_entries_description_search_trgm_idx" ON "component_entries" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "component_entries_usage_mode_search_trgm_idx" ON "component_entries" USING gin ("usage_mode" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_name_search_trgm_idx" ON "employees" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_gender_search_trgm_idx" ON "employees" USING gin ("gender" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_marital_status_search_trgm_idx" ON "employees" USING gin ("marital_status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_spouse_status_search_trgm_idx" ON "employees" USING gin ("spouse_status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_nationality_search_trgm_idx" ON "employees" USING gin ("nationality" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_identity_number_search_trgm_idx" ON "employees" USING gin ("identity_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_email_search_trgm_idx" ON "employees" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employees_phone_search_trgm_idx" ON "employees" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_pay_frequency_search_trgm_idx" ON "employment_terms" USING gin ("pay_frequency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_work_classification_search_trgm_idx" ON "employment_terms" USING gin ("work_classification" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_statutory_work_category_search_trgm_idx" ON "employment_terms" USING gin ("statutory_work_category" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_employment_type_search_trgm_idx" ON "employment_terms" USING gin ("employment_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_department_search_trgm_idx" ON "employment_terms" USING gin ("department" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_job_title_search_trgm_idx" ON "employment_terms" USING gin ("job_title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_payroll_group_search_trgm_idx" ON "employment_terms" USING gin ("payroll_group" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_terms_rest_day_search_trgm_idx" ON "employment_terms" USING gin ("rest_day" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "employments_company_id_employee_number_index" ON "employments" ("company_id","employee_number");
--> statement-breakpoint
CREATE INDEX "employments_employee_number_search_trgm_idx" ON "employments" USING gin ("employee_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employments_exit_reason_search_trgm_idx" ON "employments" USING gin ("exit_reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_code_search_trgm_idx" ON "jurisdictions" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_name_search_trgm_idx" ON "jurisdictions" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_currency_search_trgm_idx" ON "jurisdictions" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_rounding_search_trgm_idx" ON "jurisdictions" USING gin ("rounding" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_ordinary_rate_basis_search_trgm_idx" ON "jurisdictions" USING gin ("ordinary_rate_basis" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "jurisdictions_definition_hash_search_trgm_idx" ON "jurisdictions" USING gin ("definition_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_requests_employment_id_leave_type_id_from_date_index" ON "leave_requests" ("employment_id","leave_type_id","from_date");
--> statement-breakpoint
CREATE INDEX "leave_requests_kind_search_trgm_idx" ON "leave_requests" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_requests_reason_search_trgm_idx" ON "leave_requests" USING gin ("reason" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_types_code_search_trgm_idx" ON "leave_types" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_types_name_search_trgm_idx" ON "leave_types" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_types_aggregates_with_search_trgm_idx" ON "leave_types" USING gin ("aggregates_with" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_limits_period_search_trgm_idx" ON "overtime_limits" USING gin ("period" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_limits_on_exceed_search_trgm_idx" ON "overtime_limits" USING gin ("on_exceed" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_limits_authority_search_trgm_idx" ON "overtime_limits" USING gin ("authority" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_rules_day_type_search_trgm_idx" ON "overtime_rules" USING gin ("day_type" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_rules_authority_search_trgm_idx" ON "overtime_rules" USING gin ("authority" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "overtime_rule_mapped_once" ON "pay_components" ("company_id",(definition->>'rule')) WHERE definition->>'source' = 'OVERTIME';
--> statement-breakpoint
CREATE INDEX "pay_components_code_search_trgm_idx" ON "pay_components" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "pay_components_name_search_trgm_idx" ON "pay_components" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "pay_components_nature_search_trgm_idx" ON "pay_components" USING gin ("nature" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_company_id_period_index" ON "payroll_runs" ("company_id","period");
--> statement-breakpoint
CREATE INDEX "payroll_runs_period_search_trgm_idx" ON "payroll_runs" USING gin ("period" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payroll_runs_lifecycle_search_trgm_idx" ON "payroll_runs" USING gin ("lifecycle" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payroll_runs_configuration_hash_search_trgm_idx" ON "payroll_runs" USING gin ("configuration_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payslip_lines_payslip_id_index" ON "payslip_lines" ("payslip_id");
--> statement-breakpoint
CREATE INDEX "payslip_lines_pay_component_id_index" ON "payslip_lines" ("pay_component_id");
--> statement-breakpoint
CREATE INDEX "payslip_lines_statutory_contribution_id_index" ON "payslip_lines" ("statutory_contribution_id") WHERE "statutory_contribution_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_lines_component_entry_id_payslip_id_index" ON "payslip_lines" ("component_entry_id","payslip_id") WHERE "component_entry_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_lines_component_entry_id_index" ON "payslip_lines" ("component_entry_id") WHERE "component_entry_usage" = 'SINGLE_USE';
--> statement-breakpoint
CREATE INDEX "payslip_lines_component_entry_usage_search_trgm_idx" ON "payslip_lines" USING gin ("component_entry_usage" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "payslip_lines_bucket_search_trgm_idx" ON "payslip_lines" USING gin ("bucket" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_payroll_run_id_employment_id_index" ON "payslips" ("payroll_run_id","employment_id");
--> statement-breakpoint
CREATE INDEX "payslips_currency_search_trgm_idx" ON "payslips" USING gin ("currency" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "repayment_agreements_reference_search_trgm_idx" ON "repayment_agreements" USING gin ("reference" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "roster_entries_employment_id_work_date_index" ON "roster_entries" ("employment_id","work_date");
--> statement-breakpoint
CREATE INDEX "roster_entries_assignment_code_search_trgm_idx" ON "roster_entries" USING gin ("assignment_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "roster_entries_designation_search_trgm_idx" ON "roster_entries" USING gin ("designation" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "shift_definitions_code_search_trgm_idx" ON "shift_definitions" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "shift_definitions_name_search_trgm_idx" ON "shift_definitions" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "shift_definitions_start_time_search_trgm_idx" ON "shift_definitions" USING gin ("start_time" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "shift_definitions_end_time_search_trgm_idx" ON "shift_definitions" USING gin ("end_time" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_code_search_trgm_idx" ON "statutory_contributions" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_name_search_trgm_idx" ON "statutory_contributions" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_authority_search_trgm_idx" ON "statutory_contributions" USING gin ("authority" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_payer_search_trgm_idx" ON "statutory_contributions" USING gin ("payer" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_keyed_by_search_trgm_idx" ON "statutory_contributions" USING gin ("keyed_by" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "statutory_contributions_rounding_search_trgm_idx" ON "statutory_contributions" USING gin ("rounding" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "time_entries_employment_id_work_date_index" ON "time_entries" ("employment_id","work_date");
--> statement-breakpoint
CREATE INDEX "time_entries_state_search_trgm_idx" ON "time_entries" USING gin ("state" gin_trgm_ops);
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
CREATE INDEX "chat_message_role_search_trgm_idx" ON "chat_message" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_model_search_trgm_idx" ON "chat_message" USING gin ("model" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_kind_search_trgm_idx" ON "chat_message" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_status_search_trgm_idx" ON "chat_message" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_queue_status_search_trgm_idx" ON "chat_message" USING gin ("queue_status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_release_mode_search_trgm_idx" ON "chat_message" USING gin ("release_mode" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_author_display_name_search_trgm_idx" ON "chat_message" USING gin ("author_display_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_provider_search_trgm_idx" ON "chat_message" USING gin ("source_provider" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_conversation_id_search_trgm_idx" ON "chat_message" USING gin ("source_conversation_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_message_source_message_id_search_trgm_idx" ON "chat_message" USING gin ("source_message_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_title_search_trgm_idx" ON "chat_session" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_platform_search_trgm_idx" ON "chat_session" USING gin ("platform" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_visibility_search_trgm_idx" ON "chat_session" USING gin ("visibility" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_session_external_thread_id_search_trgm_idx" ON "chat_session" USING gin ("external_thread_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_status_search_trgm_idx" ON "chat_turn" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_model_search_trgm_idx" ON "chat_turn" USING gin ("model" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_subagent_id_search_trgm_idx" ON "chat_turn" USING gin ("subagent_id" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "chat_turn_error_search_trgm_idx" ON "chat_turn" USING gin ("error" gin_trgm_ops);
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
CREATE INDEX "user_avatar_url_search_trgm_idx" ON "user" USING gin ("avatar_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_status_search_trgm_idx" ON "user" USING gin ("status" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_role_search_trgm_idx" ON "user" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "user_kind_search_trgm_idx" ON "user" USING gin ("kind" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "company_holidays" ADD CONSTRAINT "company_holidays_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "component_entries" ADD CONSTRAINT "component_entries_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "component_entries" ADD CONSTRAINT "component_entries_pay_component_id_pay_components_fk" FOREIGN KEY ("pay_component_id") REFERENCES "pay_components"("norbital_id");
--> statement-breakpoint
ALTER TABLE "component_entries" ADD CONSTRAINT "component_entries_repayment_agreement_id_repayment_agreements_fk" FOREIGN KEY ("repayment_agreement_id") REFERENCES "repayment_agreements"("norbital_id");
--> statement-breakpoint
ALTER TABLE "contribution_rates" ADD CONSTRAINT "contribution_rates_statutory_contribution_id_statutory_contributions_fk" FOREIGN KEY ("statutory_contribution_id") REFERENCES "statutory_contributions"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts" ADD CONSTRAINT "employment_statutory_facts_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts" ADD CONSTRAINT "employment_statutory_facts_statutory_contribution_id_statutory_contributions_fk" FOREIGN KEY ("statutory_contribution_id") REFERENCES "statutory_contributions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "employment_terms" ADD CONSTRAINT "employment_terms_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_employee_id_employees_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("norbital_id");
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_fk" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("norbital_id");
--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "overtime_limits" ADD CONSTRAINT "overtime_limits_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "overtime_rules" ADD CONSTRAINT "overtime_rules_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_payslips_fk" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_pay_component_id_pay_components_fk" FOREIGN KEY ("pay_component_id") REFERENCES "pay_components"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_component_entry_id_component_entries_fk" FOREIGN KEY ("component_entry_id") REFERENCES "component_entries"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_statutory_contribution_id_statutory_contributions_fk" FOREIGN KEY ("statutory_contribution_id") REFERENCES "statutory_contributions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_run_id_payroll_runs_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "repayment_agreements" ADD CONSTRAINT "repayment_agreements_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "repayment_agreements" ADD CONSTRAINT "repayment_agreements_pay_component_id_pay_components_fk" FOREIGN KEY ("pay_component_id") REFERENCES "pay_components"("norbital_id");
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_shift_definition_id_shift_definitions_fk" FOREIGN KEY ("shift_definition_id") REFERENCES "shift_definitions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "shift_definitions" ADD CONSTRAINT "shift_definitions_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "statutory_contributions" ADD CONSTRAINT "statutory_contributions_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employment_id_employments_fk" FOREIGN KEY ("employment_id") REFERENCES "employments"("norbital_id");
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_norbital_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_requested_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD CONSTRAINT "channel_conversation_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_X3p24605t0lh_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversation"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_Oyde72058Ltn_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_message"("norbital_id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_turn_id_chat_turn_norbital_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat_turn"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_author_user_id_user_norbital_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_user_id_user_norbital_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_automation_run_id_automation_run_norbital_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");
--> statement-breakpoint
ALTER TABLE "chat_turn" ADD CONSTRAINT "chat_turn_chat_id_chat_session_norbital_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chat_session"("norbital_id") ON DELETE CASCADE;
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
