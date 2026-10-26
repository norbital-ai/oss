-- step validate_log (validating)
-- hazard: scans existing records with a lock that permits ordinary reads and writes.
ALTER TABLE "bolt_audit".event VALIDATE CONSTRAINT event_check;
ALTER TABLE "bolt_audit".event VALIDATE CONSTRAINT event_recorded_at_check;
