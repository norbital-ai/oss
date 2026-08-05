ALTER TABLE "roster_entries" ALTER COLUMN "shift_definition_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "roster_entries_history" ALTER COLUMN "shift_definition_id" DROP NOT NULL;
