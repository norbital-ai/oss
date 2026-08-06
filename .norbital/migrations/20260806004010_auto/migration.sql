ALTER TABLE "employment_terms" ADD COLUMN "summary" text GENERATED ALWAYS AS (COALESCE(job_title || ' · ', '') || employment_type) STORED;
--> statement-breakpoint
ALTER TABLE "employment_terms_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (COALESCE(job_title || ' · ', '') || employment_type) STORED;
--> statement-breakpoint
ALTER TABLE "rest_break_rules" ADD COLUMN "summary" text GENERATED ALWAYS AS (applies_when || ' · ' || minimum_minutes || ' min') STORED;
--> statement-breakpoint
ALTER TABLE "rest_break_rules_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (applies_when || ' · ' || minimum_minutes || ' min') STORED;
--> statement-breakpoint
CREATE INDEX "employment_terms_summary_search_trgm_idx" ON "employment_terms" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "rest_break_rules_summary_search_trgm_idx" ON "rest_break_rules" USING gin ("summary" gin_trgm_ops);
