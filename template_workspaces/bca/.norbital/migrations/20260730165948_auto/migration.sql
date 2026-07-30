ALTER TABLE "chat_message" ADD COLUMN "usage" jsonb;
--> statement-breakpoint
ALTER TABLE "chat_message_history" ADD COLUMN "usage" jsonb;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_session_history" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_session" ADD CONSTRAINT "chat_session_automation_run_id_automation_run_norbital_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_run"("norbital_id");
