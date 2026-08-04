CREATE TABLE "rosters" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"work_pattern_id" uuid NOT NULL,
	"month" text NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
SELECT _norbital_create_history_table('rosters'::regclass, 'rosters_history');
--> statement-breakpoint
CREATE TABLE "work_patterns" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" tstzrange DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"variant" jsonb NOT NULL,
	"default_shift_definition_id" uuid,
	"min_rest_days_per_week" integer DEFAULT 1 NOT NULL,
	"max_consecutive_work_days" integer,
	"max_daily_work_minutes" integer,
	"min_minutes_between_shifts" integer,
	"effective_range" jsonb NOT NULL
);
--> statement-breakpoint
SELECT _norbital_create_history_table('work_patterns'::regclass, 'work_patterns_history');
--> statement-breakpoint
ALTER TABLE "employment_terms" ADD COLUMN "work_pattern_id" uuid;
--> statement-breakpoint
ALTER TABLE "employment_terms_history" ADD COLUMN "work_pattern_id" uuid;
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD COLUMN "roster_id" uuid;
--> statement-breakpoint
ALTER TABLE "roster_entries_history" ADD COLUMN "roster_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "rosters_company_id_work_pattern_id_month_index" ON "rosters" ("company_id","work_pattern_id","month");
--> statement-breakpoint
CREATE INDEX "rosters_month_search_trgm_idx" ON "rosters" USING gin ("month" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "work_patterns_code_search_trgm_idx" ON "work_patterns" USING gin ("code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "work_patterns_name_search_trgm_idx" ON "work_patterns" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "employment_terms" ADD CONSTRAINT "employment_terms_work_pattern_id_work_patterns_fk" FOREIGN KEY ("work_pattern_id") REFERENCES "work_patterns"("norbital_id");
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_id_rosters_fk" FOREIGN KEY ("roster_id") REFERENCES "rosters"("norbital_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_work_pattern_id_work_patterns_fk" FOREIGN KEY ("work_pattern_id") REFERENCES "work_patterns"("norbital_id");
--> statement-breakpoint
ALTER TABLE "work_patterns" ADD CONSTRAINT "work_patterns_company_id_companies_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("norbital_id");
--> statement-breakpoint
ALTER TABLE "work_patterns" ADD CONSTRAINT "work_patterns_default_shift_definition_id_shift_definitions_fk" FOREIGN KEY ("default_shift_definition_id") REFERENCES "shift_definitions"("norbital_id");
