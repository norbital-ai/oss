ALTER TABLE "defects" ALTER COLUMN "reported_date" SET DATA TYPE date USING "reported_date"::date;
--> statement-breakpoint
ALTER TABLE "defects_history" ALTER COLUMN "reported_date" SET DATA TYPE date USING "reported_date"::date;
--> statement-breakpoint
ALTER TABLE "defects" ALTER COLUMN "due_date" SET DATA TYPE date USING "due_date"::date;
--> statement-breakpoint
ALTER TABLE "defects_history" ALTER COLUMN "due_date" SET DATA TYPE date USING "due_date"::date;
--> statement-breakpoint
ALTER TABLE "defects" ALTER COLUMN "closed_date" SET DATA TYPE date USING "closed_date"::date;
--> statement-breakpoint
ALTER TABLE "defects_history" ALTER COLUMN "closed_date" SET DATA TYPE date USING "closed_date"::date;
--> statement-breakpoint
ALTER TABLE "payment_claims" ALTER COLUMN "submitted_date" SET DATA TYPE date USING "submitted_date"::date;
--> statement-breakpoint
ALTER TABLE "payment_claims_history" ALTER COLUMN "submitted_date" SET DATA TYPE date USING "submitted_date"::date;
--> statement-breakpoint
ALTER TABLE "payment_claims" ALTER COLUMN "paid_date" SET DATA TYPE date USING "paid_date"::date;
--> statement-breakpoint
ALTER TABLE "payment_claims_history" ALTER COLUMN "paid_date" SET DATA TYPE date USING "paid_date"::date;
--> statement-breakpoint
ALTER TABLE "permits_to_work" ALTER COLUMN "requested_date" SET DATA TYPE date USING "requested_date"::date;
--> statement-breakpoint
ALTER TABLE "permits_to_work_history" ALTER COLUMN "requested_date" SET DATA TYPE date USING "requested_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis" ALTER COLUMN "submitted_date" SET DATA TYPE date USING "submitted_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis_history" ALTER COLUMN "submitted_date" SET DATA TYPE date USING "submitted_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis" ALTER COLUMN "due_date" SET DATA TYPE date USING "due_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis_history" ALTER COLUMN "due_date" SET DATA TYPE date USING "due_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis" ALTER COLUMN "resolved_date" SET DATA TYPE date USING "resolved_date"::date;
--> statement-breakpoint
ALTER TABLE "rfis_history" ALTER COLUMN "resolved_date" SET DATA TYPE date USING "resolved_date"::date;
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "date_of_birth" SET DATA TYPE date USING "date_of_birth"::date;
--> statement-breakpoint
ALTER TABLE "workers_history" ALTER COLUMN "date_of_birth" SET DATA TYPE date USING "date_of_birth"::date;
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "work_permit_expiry" SET DATA TYPE date USING "work_permit_expiry"::date;
--> statement-breakpoint
ALTER TABLE "workers_history" ALTER COLUMN "work_permit_expiry" SET DATA TYPE date USING "work_permit_expiry"::date;
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "medical_check_date" SET DATA TYPE date USING "medical_check_date"::date;
--> statement-breakpoint
ALTER TABLE "workers_history" ALTER COLUMN "medical_check_date" SET DATA TYPE date USING "medical_check_date"::date;
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "safety_induction_date" SET DATA TYPE date USING "safety_induction_date"::date;
--> statement-breakpoint
ALTER TABLE "workers_history" ALTER COLUMN "safety_induction_date" SET DATA TYPE date USING "safety_induction_date"::date;
