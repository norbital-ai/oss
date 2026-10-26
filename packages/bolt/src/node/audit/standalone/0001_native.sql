-- step native_log (additive)
-- hazard: legacy native layout; adoption requires an exact native and privilege proof.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE SCHEMA IF NOT EXISTS bolt_audit;
REVOKE ALL ON SCHEMA bolt_audit FROM PUBLIC;
CREATE TABLE IF NOT EXISTS bolt_audit.event (
  id text PRIMARY KEY CHECK (id<>''),
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  event jsonb NOT NULL CHECK ((
    jsonb_typeof(event)='object'
    AND event ?& ARRAY['id','operationId','at','category','action','status','actor','subject','invocation','transaction','run','approval','payload']
    AND event->>'id'=id AND coalesce(length(event->>'operationId'),0)>0 AND coalesce(length(event->>'action'),0)>0
    AND event->>'category' IN ('write','approval','identity','automation','integration')
    AND event->>'status' IN ('prepared','committed','pendingApproval','refused','conflict','failed','unknown')
    AND jsonb_typeof(event->'actor')='object'
    AND event->'actor'->>'kind' IN ('member','envoy','visitor','apiKey','system')
    AND occurred_at=(event->>'at')::timestamptz
  ) IS TRUE),
  payload_bytes integer GENERATED ALWAYS AS (octet_length((event->'payload')::text)) STORED NOT NULL,
  document text GENERATED ALWAYS AS (event::text) STORED
);
CREATE INDEX IF NOT EXISTS event_time ON bolt_audit.event (occurred_at,id);
CREATE INDEX IF NOT EXISTS event_retention ON bolt_audit.event (recorded_at,id);
CREATE INDEX IF NOT EXISTS event_actor ON bolt_audit.event ((event->'actor'->>'kind'),(event->'actor'->>'id'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_subject ON bolt_audit.event ((event->'subject'->>'model'),(event->'subject'->>'id'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_status ON bolt_audit.event ((event->>'status'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_category ON bolt_audit.event ((event->>'category'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_action ON bolt_audit.event ((event->>'action'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_invocation ON bolt_audit.event ((event->>'invocation'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_run ON bolt_audit.event ((event->>'run'),occurred_at,id);
CREATE INDEX IF NOT EXISTS event_pending ON bolt_audit.event (occurred_at,id) WHERE event->>'status'='prepared';
CREATE INDEX IF NOT EXISTS event_search ON bolt_audit.event USING gin (document public.gin_trgm_ops);
CREATE OR REPLACE FUNCTION bolt_audit.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.recorded_at<=clock_timestamp()-interval '30 days' THEN RETURN OLD; END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.occurred_at,NEW.recorded_at,NEW.event)
       IS NOT DISTINCT FROM ROW(OLD.id,OLD.occurred_at,OLD.recorded_at,OLD.event)
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE='BA101', MESSAGE='Audit events are immutable during their 30-day retention';
END $$;
DROP TRIGGER IF EXISTS immutable ON bolt_audit.event;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bolt_audit.event FOR EACH ROW EXECUTE FUNCTION bolt_audit.immutable();
DROP TRIGGER IF EXISTS immutable_truncate ON bolt_audit.event;
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON bolt_audit.event FOR EACH STATEMENT EXECUTE FUNCTION bolt_audit.immutable();
CREATE OR REPLACE FUNCTION bolt_audit.append(p_events jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item jsonb; written text;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    INSERT INTO bolt_audit.event AS existing (id,occurred_at,event)
      VALUES (item->>'id',(item->>'at')::timestamptz,item)
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
        WHERE existing.event=EXCLUDED.event RETURNING existing.id INTO written;
    IF written IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='BA102', MESSAGE='Audit event id already has different content';
    END IF;
  END LOOP;
END $$;
