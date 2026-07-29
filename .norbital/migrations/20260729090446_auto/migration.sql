CREATE TABLE "project_documents" (
	"norbital_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"norbital_created_at" timestamp with time zone DEFAULT now(),
	"norbital_updated_at" timestamp with time zone DEFAULT now(),
	"norbital_sys_period" text DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text) NOT NULL,
	"norbital_row_version" integer DEFAULT 1,
	"norbital_approval_id" uuid,
	"title" text NOT NULL,
	"project_id" uuid NOT NULL,
	"category" text NOT NULL,
	"document_role" text,
	"document_file" uuid NOT NULL,
	"document_number" text,
	"discipline" text,
	"revision" text,
	"issued_on" date,
	"issued_by" text,
	"status" text,
	"tags" text[],
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "project_documents_project_id_index" ON "project_documents" ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_category_index" ON "project_documents" ("category");--> statement-breakpoint
CREATE INDEX "project_documents_title_search_trgm_idx" ON "project_documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_category_search_trgm_idx" ON "project_documents" USING gin ("category" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_document_role_search_trgm_idx" ON "project_documents" USING gin ("document_role" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_document_number_search_trgm_idx" ON "project_documents" USING gin ("document_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_discipline_search_trgm_idx" ON "project_documents" USING gin ("discipline" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_revision_search_trgm_idx" ON "project_documents" USING gin ("revision" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_issued_by_search_trgm_idx" ON "project_documents" USING gin ("issued_by" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_status_search_trgm_idx" ON "project_documents" USING gin ("status" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_documents_notes_search_trgm_idx" ON "project_documents" USING gin ("notes" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_reclamation_projects_fk" FOREIGN KEY ("project_id") REFERENCES "reclamation_projects"("norbital_id");