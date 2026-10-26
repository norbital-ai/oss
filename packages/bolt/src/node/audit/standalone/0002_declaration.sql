-- step declared_log (validating)
-- hazard: brief metadata locks; new writes are checked immediately; existing rows validate in the next transaction.
ALTER TABLE "bolt_audit".event DROP CONSTRAINT event_check;
ALTER TABLE "bolt_audit".event ADD CONSTRAINT event_check CHECK ((jsonb_typeof(event)='object'
AND event ?& ARRAY['id','operationId','at','category','action','status','actor','subject','invocation','transaction','run','approval','payload']
AND event->>'id'=id
AND coalesce(length(event->>'operationId'),0)>0
AND coalesce(length(event->>'action'),0)>0
AND event->>'category' IN ('write','approval','identity','automation','integration')
AND event->>'status' IN ('prepared','committed','pendingApproval','refused','conflict','failed','unknown')
AND event->'actor'->>'kind' IN ('member','envoy','visitor','apiKey','system')
AND jsonb_typeof(event->'actor')='object'
AND occurred_at=(event->>'at')::timestamptz) IS TRUE) NOT VALID;
ALTER TABLE "bolt_audit".event DROP CONSTRAINT IF EXISTS event_recorded_at_check;
ALTER TABLE "bolt_audit".event ADD CONSTRAINT event_recorded_at_check CHECK (isfinite(recorded_at)) NOT VALID;
REVOKE ALL ON SCHEMA "bolt_audit" FROM PUBLIC;
REVOKE ALL ON TABLE "bolt_audit".event FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '
BEGIN
IF TG_OP=''UPDATE'' THEN
 IF ROW(NEW.id,NEW.occurred_at,NEW.recorded_at,NEW.event) IS NOT DISTINCT FROM ROW(OLD.id,OLD.occurred_at,OLD.recorded_at,OLD.event) THEN RETURN NEW; END IF;
END IF;
IF TG_OP=''DELETE'' THEN IF OLD.recorded_at<=clock_timestamp()-interval ''30 days'' THEN RETURN OLD; END IF; END IF;
RAISE EXCEPTION USING ERRCODE=''BA101'', MESSAGE=''Log events are immutable'';
END ';
REVOKE ALL ON FUNCTION "bolt_audit".immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".append(p_events jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS '
DECLARE item jsonb; written text;
BEGIN

FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
 INSERT INTO "bolt_audit".event AS existing (id,occurred_at,event)
 VALUES (item->>''id'',(item->>''at'')::timestamptz,item)
 ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE existing.event=EXCLUDED.event RETURNING existing.id INTO written;
 IF written IS NULL THEN RAISE EXCEPTION USING ERRCODE=''BA102'', MESSAGE=''Log event id already has different content''; END IF;
END LOOP;
END ';
REVOKE ALL ON FUNCTION "bolt_audit".append(jsonb) FROM PUBLIC;
DROP TRIGGER immutable ON "bolt_audit".event;
DROP TRIGGER immutable_truncate ON "bolt_audit".event;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "bolt_audit".event FOR EACH ROW EXECUTE FUNCTION "bolt_audit".immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON "bolt_audit".event FOR EACH STATEMENT EXECUTE FUNCTION "bolt_audit".immutable();
