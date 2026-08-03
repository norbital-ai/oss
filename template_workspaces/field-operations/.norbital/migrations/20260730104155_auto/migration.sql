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
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'basic';
--> statement-breakpoint
ALTER TABLE "user_history" ALTER COLUMN "role" SET DEFAULT 'basic';
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
CREATE INDEX "invitation_email_search_trgm_idx" ON "invitation" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invitation_token_hash_search_trgm_idx" ON "invitation" USING gin ("token_hash" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "invitation_role_search_trgm_idx" ON "invitation" USING gin ("role" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_user_norbital_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "user"("norbital_id");
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_consumed_user_id_user_norbital_id_fkey" FOREIGN KEY ("consumed_user_id") REFERENCES "user"("norbital_id");
