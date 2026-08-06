ALTER TABLE "photo_evidence" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE source ->> 'kind'
				WHEN 'workspace_upload' THEN 'Workspace upload'
				WHEN 'channel' THEN 'From ' || COALESCE(NULLIF(source ->> 'provider', ''), 'a channel') || COALESCE(' · ' || LEFT(source ->> 'sent_at', 10), '')
				ELSE 'Photo'
			END) STORED;
--> statement-breakpoint
ALTER TABLE "photo_evidence_history" ADD COLUMN "summary" text GENERATED ALWAYS AS (CASE source ->> 'kind'
				WHEN 'workspace_upload' THEN 'Workspace upload'
				WHEN 'channel' THEN 'From ' || COALESCE(NULLIF(source ->> 'provider', ''), 'a channel') || COALESCE(' · ' || LEFT(source ->> 'sent_at', 10), '')
				ELSE 'Photo'
			END) STORED;
--> statement-breakpoint
CREATE INDEX "photo_evidence_summary_search_trgm_idx" ON "photo_evidence" USING gin ("summary" gin_trgm_ops);
