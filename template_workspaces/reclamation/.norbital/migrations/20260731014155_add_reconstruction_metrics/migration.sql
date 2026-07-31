ALTER TABLE "site_reconstructions" ADD COLUMN "placed_volume_m3" numeric;--> statement-breakpoint
ALTER TABLE "site_reconstructions" ADD COLUMN "metrics_json" text;--> statement-breakpoint
CREATE INDEX "site_reconstructions_metrics_json_search_trgm_idx" ON "site_reconstructions" USING gin ("metrics_json" gin_trgm_ops);