-- step authoring_names (data)
-- hazard: an exclusive log-table lock and one rewrite of structured envelope names during the release cutover.
LOCK TABLE "bolt_audit".event IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "bolt_audit".event DISABLE TRIGGER immutable;
ALTER TABLE "bolt_audit".event DROP CONSTRAINT event_check;
UPDATE "bolt_audit".event SET event = jsonb_set(event, '{status}', '"pending_approval"'::jsonb)
WHERE event->>'status' = 'pendingApproval';
UPDATE "bolt_audit".event SET event = jsonb_set(event, '{actor,kind}', '"api_key"'::jsonb)
WHERE event->'actor'->>'kind' = 'apiKey';
ALTER TABLE "bolt_audit".event ADD CONSTRAINT event_check CHECK ((jsonb_typeof(event)='object'
AND event ?& ARRAY['id','operationId','at','category','action','status','actor','subject','invocation','transaction','run','approval','payload']
AND event->>'id'=id
AND coalesce(length(event->>'operationId'),0)>0
AND coalesce(length(event->>'action'),0)>0
AND event->>'category' IN ('write','approval','identity','automation','integration')
AND event->>'status' IN ('prepared','committed','pending_approval','refused','conflict','failed','unknown')
AND event->'actor'->>'kind' IN ('member','envoy','visitor','api_key','system')
AND jsonb_typeof(event->'actor')='object'
AND occurred_at=(event->>'at')::timestamptz) IS TRUE) NOT VALID;
ALTER TABLE "bolt_audit".event VALIDATE CONSTRAINT event_check;
ALTER TABLE "bolt_audit".event ENABLE TRIGGER immutable;
