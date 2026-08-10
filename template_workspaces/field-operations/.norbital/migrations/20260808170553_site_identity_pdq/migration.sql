ALTER TABLE "job_assignments" ADD COLUMN "site_identity_unverified" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "site_identity_evidence_id" uuid;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "extracted_site_name" text;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "extracted_site_location" text;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "extracted_unit_number" text;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "site_identity_confidence" text;
--> statement-breakpoint
ALTER TABLE "job_assignments" ADD COLUMN "site_identity_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "site_identity_unverified" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "site_identity_evidence_id" uuid;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "extracted_site_name" text;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "extracted_site_location" text;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "extracted_unit_number" text;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "site_identity_confidence" text;
--> statement-breakpoint
ALTER TABLE "job_assignments_history" ADD COLUMN "site_identity_checked_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "job_assignments" SET "status" = 'suspect' WHERE "status" = 'flagged';
--> statement-breakpoint
UPDATE "job_assignments_history" SET "status" = 'suspect' WHERE "status" = 'flagged';
--> statement-breakpoint
DROP INDEX IF EXISTS "photo_evidence_perceptual_hash_index";
--> statement-breakpoint
DROP INDEX IF EXISTS "photo_evidence_perceptual_hash_search_trgm_idx";
--> statement-breakpoint
ALTER TABLE "photo_evidence" ADD COLUMN "perceptual_embedding" vector(256);
--> statement-breakpoint
ALTER TABLE "photo_evidence_history" ADD COLUMN "perceptual_embedding" vector(256);
--> statement-breakpoint
UPDATE "photo_evidence"
SET "perceptual_embedding" = array_fill(0::real, ARRAY[256])::vector(256)
WHERE "perceptual_embedding" IS NULL;
--> statement-breakpoint
UPDATE "photo_evidence_history"
SET "perceptual_embedding" = array_fill(0::real, ARRAY[256])::vector(256)
WHERE "perceptual_embedding" IS NULL;
--> statement-breakpoint
ALTER TABLE "photo_evidence" ALTER COLUMN "perceptual_embedding" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "photo_evidence_history" ALTER COLUMN "perceptual_embedding" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "photo_evidence" DROP COLUMN "perceptual_hash";
--> statement-breakpoint
ALTER TABLE "photo_evidence_history" DROP COLUMN "perceptual_hash";
--> statement-breakpoint
CREATE INDEX "job_assignments_extracted_site_name_search_trgm_idx" ON "job_assignments" USING gin ("extracted_site_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_extracted_site_location_search_trgm_idx" ON "job_assignments" USING gin ("extracted_site_location" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_extracted_unit_number_search_trgm_idx" ON "job_assignments" USING gin ("extracted_unit_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "job_assignments_site_identity_confidence_search_trgm_idx" ON "job_assignments" USING gin ("site_identity_confidence" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "photo_evidence_pdq_hnsw" ON "photo_evidence" USING hnsw ("perceptual_embedding" vector_l2_ops);
