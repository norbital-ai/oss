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
CREATE INDEX "integration_cursor_integration_name_search_trgm_idx" ON "integration_cursor" USING gin ("integration_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_binding_name_search_trgm_idx" ON "integration_cursor" USING gin ("binding_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_binding_key_search_trgm_idx" ON "integration_cursor" USING gin ("binding_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_cursor_search_trgm_idx" ON "integration_cursor" USING gin ("cursor" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "integration_cursor_last_error_search_trgm_idx" ON "integration_cursor" USING gin ("last_error" gin_trgm_ops);
