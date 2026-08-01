ALTER TABLE "repayment_agreements" ALTER COLUMN "disbursed_on" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "repayment_agreements_history" ALTER COLUMN "disbursed_on" DROP NOT NULL;
