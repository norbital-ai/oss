CREATE TABLE "overtime_coverage_rules" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"wage_ceiling" jsonb,
	"ceiling_is_inclusive" boolean,
	"wage_basis" text,
	"category_basis" text NOT NULL,
	"exempt_categories" text[] NOT NULL,
	"excluded_categories" text[] NOT NULL,
	"authority" text NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('overtime_coverage_rules'::regclass, 'overtime_coverage_rules_history');
--> statement-breakpoint
CREATE TABLE "rest_break_rules" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"after_consecutive_hours" numeric,
	"minimum_minutes" integer NOT NULL,
	"counts_as_worked_time" boolean,
	"applies_when" text NOT NULL,
	"authority" text NOT NULL,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('rest_break_rules'::regclass, 'rest_break_rules_history');
--> statement-breakpoint
ALTER TABLE "contribution_rates" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE selector ->> 'by'
				WHEN 'WAGE' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞')
				WHEN 'WAGE_AND_AGE' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞') || ' · age ' || (selector ->> 'age_from') || '–' || COALESCE(selector ->> 'age_to', '∞')
				WHEN 'WAGE_AND_MARITAL' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞') || ' · ' || LOWER(selector ->> 'marital')
				WHEN 'HEADCOUNT' THEN 'headcount ' || (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞')
				WHEN 'RISK_CLASS' THEN 'risk ' || (selector ->> 'class')
				ELSE 'band'
			END || ' · from ' || LEFT(effective_range ->> 'start', 10)) STORED;
--> statement-breakpoint
ALTER TABLE "contribution_rates_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE selector ->> 'by'
				WHEN 'WAGE' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞')
				WHEN 'WAGE_AND_AGE' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞') || ' · age ' || (selector ->> 'age_from') || '–' || COALESCE(selector ->> 'age_to', '∞')
				WHEN 'WAGE_AND_MARITAL' THEN (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞') || ' · ' || LOWER(selector ->> 'marital')
				WHEN 'HEADCOUNT' THEN 'headcount ' || (selector ->> 'from') || ' – ' || COALESCE(selector ->> 'to', '∞')
				WHEN 'RISK_CLASS' THEN 'risk ' || (selector ->> 'class')
				ELSE 'band'
			END || ' · from ' || LEFT(effective_range ->> 'start', 10)) STORED;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE status ->> 'kind'
				WHEN 'REGISTERED' THEN 'Registered · ' || COALESCE(NULLIF(status ->> 'reference_number', ''), 'no reference')
				WHEN 'NOT_REGISTERED' THEN 'Not registered · ' || COALESCE(NULLIF(status ->> 'reason', ''), 'no reason given')
				ELSE 'Statutory fact'
			END || ' · from ' || LEFT(effective_range ->> 'start', 10)) STORED;
--> statement-breakpoint
ALTER TABLE "employment_statutory_facts_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE status ->> 'kind'
				WHEN 'REGISTERED' THEN 'Registered · ' || COALESCE(NULLIF(status ->> 'reference_number', ''), 'no reference')
				WHEN 'NOT_REGISTERED' THEN 'Not registered · ' || COALESCE(NULLIF(status ->> 'reason', ''), 'no reason given')
				ELSE 'Statutory fact'
			END || ' · from ' || LEFT(effective_range ->> 'start', 10)) STORED;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE
				WHEN event ->> 'kind' = 'TIME_OFF'
					THEN 'Time off · ' || (event ->> 'from_date') || ' → ' || (event ->> 'to_date') || ' · ' || (event ->> 'days') || 'd'
				WHEN event ->> 'kind' = 'BALANCE_ADJUSTMENT'
					THEN 'Balance adjustment · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
				WHEN event ->> 'kind' = 'ENCASHMENT'
					THEN 'Encashment · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
				ELSE 'Leave movement · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
			END) STORED;
--> statement-breakpoint
ALTER TABLE "leave_requests_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE
				WHEN event ->> 'kind' = 'TIME_OFF'
					THEN 'Time off · ' || (event ->> 'from_date') || ' → ' || (event ->> 'to_date') || ' · ' || (event ->> 'days') || 'd'
				WHEN event ->> 'kind' = 'BALANCE_ADJUSTMENT'
					THEN 'Balance adjustment · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
				WHEN event ->> 'kind' = 'ENCASHMENT'
					THEN 'Encashment · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
				ELSE 'Leave movement · ' || (event ->> 'effective_on') || ' · ' || (event ->> 'movement_days') || 'd'
			END) STORED;
--> statement-breakpoint
ALTER TABLE "overtime_limits" ADD COLUMN "measures" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "overtime_limits_history" ADD COLUMN "measures" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "overtime_authorized";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "overtime_authorized";
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "approved_ot_1x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "approved_ot_1x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "approved_ot_15x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "approved_ot_15x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "approved_ot_2x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "approved_ot_2x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "approved_ot_3x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "approved_ot_3x_hours";
--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "approved_ot_flat_hours";
--> statement-breakpoint
ALTER TABLE "time_entries_history" DROP COLUMN "approved_ot_flat_hours";
--> statement-breakpoint
CREATE INDEX "contribution_rates_summary_search_trgm_idx" ON "contribution_rates" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "employment_statutory_facts_summary_search_trgm_idx" ON "employment_statutory_facts" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "leave_requests_summary_search_trgm_idx" ON "leave_requests" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_coverage_rules_wage_basis_search_trgm_idx" ON "overtime_coverage_rules" USING gin ("wage_basis" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_coverage_rules_category_basis_search_trgm_idx" ON "overtime_coverage_rules" USING gin ("category_basis" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_coverage_rules_authority_search_trgm_idx" ON "overtime_coverage_rules" USING gin ("authority" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "overtime_limits_measures_search_trgm_idx" ON "overtime_limits" USING gin ("measures" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rest_break_rules_applies_when_search_trgm_idx" ON "rest_break_rules" USING gin ("applies_when" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rest_break_rules_authority_search_trgm_idx" ON "rest_break_rules" USING gin ("authority" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "overtime_coverage_rules" ADD CONSTRAINT "overtime_coverage_rules_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
--> statement-breakpoint
ALTER TABLE "rest_break_rules" ADD CONSTRAINT "rest_break_rules_jurisdiction_id_jurisdictions_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("norbital_id");
