ALTER TABLE "team" ALTER COLUMN "policy_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_history" ALTER COLUMN "policy_id" DROP NOT NULL;
