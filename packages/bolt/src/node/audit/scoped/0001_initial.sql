-- step initial_log (additive)
CREATE SCHEMA "bolt_audit";
REVOKE ALL ON SCHEMA "bolt_audit" FROM PUBLIC;
CREATE TABLE "bolt_audit".tenant_retirement ("platform" text NOT NULL CHECK ("platform"<>''), "tenant" text NOT NULL CHECK ("tenant"<>''), retired_at timestamptz CHECK (retired_at IS NULL OR isfinite(retired_at)), PRIMARY KEY ("platform","tenant"));
REVOKE ALL ON TABLE "bolt_audit".tenant_retirement FROM PUBLIC;
CREATE TABLE "bolt_audit".event (
"platform" text NOT NULL CHECK ("platform"<>''),
"tenant" text NOT NULL CHECK ("tenant"<>''),
"environment" text NOT NULL CHECK ("environment"<>''),
id text NOT NULL CHECK (id<>''),
occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
event jsonb NOT NULL CONSTRAINT event_check CHECK ((jsonb_typeof(event)='object'
AND event ?& ARRAY['id','operationId','at','category','action','status','actor','subject','invocation','transaction','run','approval','payload']
AND event->>'id'=id
AND coalesce(length(event->>'operationId'),0)>0
AND coalesce(length(event->>'action'),0)>0
AND event->>'category' IN ('write','approval','identity','automation','integration')
AND event->>'status' IN ('prepared','committed','pending_approval','refused','conflict','failed','unknown')
AND event->'actor'->>'kind' IN ('member','envoy','visitor','api_key','system')
AND jsonb_typeof(event->'actor')='object'
AND occurred_at=(event->>'at')::timestamptz) IS TRUE),
payload_bytes integer GENERATED ALWAYS AS (octet_length((event->'payload')::text)) STORED NOT NULL,
document text GENERATED ALWAYS AS (event::text) STORED,
PRIMARY KEY ("platform","tenant","environment",id));
REVOKE ALL ON TABLE "bolt_audit".event FROM PUBLIC;
CREATE INDEX "event_time" ON "bolt_audit".event ("platform","tenant","environment",occurred_at,id);
CREATE INDEX "event_actor" ON "bolt_audit".event ("platform","tenant","environment",(event->'actor'->>'kind'),(event->'actor'->>'id'),occurred_at,id);
CREATE INDEX "event_subject" ON "bolt_audit".event ("platform","tenant","environment",(event->'subject'->>'model'),(event->'subject'->>'id'),occurred_at,id);
CREATE INDEX "event_status" ON "bolt_audit".event ("platform","tenant","environment",(event->>'status'),occurred_at,id);
CREATE INDEX "event_category" ON "bolt_audit".event ("platform","tenant","environment",(event->>'category'),occurred_at,id);
CREATE INDEX "event_action" ON "bolt_audit".event ("platform","tenant","environment",(event->>'action'),occurred_at,id);
CREATE INDEX "event_invocation" ON "bolt_audit".event ("platform","tenant","environment",(event->>'invocation'),occurred_at,id);
CREATE INDEX "event_run" ON "bolt_audit".event ("platform","tenant","environment",(event->>'run'),occurred_at,id);
CREATE INDEX "event_pending" ON "bolt_audit".event ("platform","tenant","environment",occurred_at,id) WHERE event->>'status'='prepared';
CREATE INDEX event_search ON "bolt_audit".event USING gin (document public.gin_trgm_ops);
CREATE INDEX "event_retention" ON "bolt_audit".event ("platform",recorded_at);
CREATE TABLE "bolt_audit".maintenance (
pid integer NOT NULL, xid bigint NOT NULL,
"platform" text NOT NULL CHECK ("platform"<>''), "tenant" text, cutoff timestamptz,
PRIMARY KEY (pid,xid), CHECK (("tenant" IS NOT NULL AND "tenant"<>'' AND cutoff IS NULL)
OR ("tenant" IS NULL AND cutoff IS NOT NULL AND isfinite(cutoff))));
REVOKE ALL ON TABLE "bolt_audit".maintenance FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '
BEGIN
IF TG_OP=''UPDATE'' THEN
 IF ROW(NEW."platform",NEW."tenant",NEW."environment",NEW.id,NEW.occurred_at,NEW.recorded_at,NEW.event) IS NOT DISTINCT FROM ROW(OLD."platform",OLD."tenant",OLD."environment",OLD.id,OLD.occurred_at,OLD.recorded_at,OLD.event) THEN RETURN NEW; END IF;
END IF;
IF TG_OP=''DELETE'' THEN IF EXISTS (SELECT 1 FROM "bolt_audit".maintenance capability WHERE capability.pid=pg_backend_pid() AND capability.xid=txid_current()
AND capability."platform"=OLD."platform"
AND (capability."tenant"=OLD."tenant" OR (capability."tenant" IS NULL AND OLD.recorded_at<=capability.cutoff))) THEN RETURN OLD; END IF; END IF;
RAISE EXCEPTION USING ERRCODE=''BA101'', MESSAGE=''Log events are immutable'';
END ';
REVOKE ALL ON FUNCTION "bolt_audit".immutable() FROM PUBLIC;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "bolt_audit".event FOR EACH ROW EXECUTE FUNCTION "bolt_audit".immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON "bolt_audit".event FOR EACH STATEMENT EXECUTE FUNCTION "bolt_audit".immutable();
CREATE OR REPLACE FUNCTION "bolt_audit".append(p_platform text,p_tenant text,p_environment text,p_events jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS '
DECLARE item jsonb; written text;
BEGIN
INSERT INTO "bolt_audit".tenant_retirement ("platform","tenant") VALUES (p_platform,p_tenant) ON CONFLICT DO NOTHING;
PERFORM 1 FROM "bolt_audit".tenant_retirement WHERE "platform"=p_platform AND "tenant"=p_tenant AND retired_at IS NULL FOR SHARE;
IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE=''BA103'', MESSAGE=''The log namespace is permanently retired''; END IF;
FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
 INSERT INTO "bolt_audit".event AS existing ("platform","tenant","environment",id,occurred_at,event)
 VALUES (p_platform,p_tenant,p_environment,item->>''id'',(item->>''at'')::timestamptz,item)
 ON CONFLICT ("platform","tenant","environment",id) DO UPDATE SET id=EXCLUDED.id WHERE existing.event=EXCLUDED.event RETURNING existing.id INTO written;
 IF written IS NULL THEN RAISE EXCEPTION USING ERRCODE=''BA102'', MESSAGE=''Log event id already has different content''; END IF;
END LOOP;
END ';
REVOKE ALL ON FUNCTION "bolt_audit".append(text,text,text,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".retire_tenant(p_platform text,p_tenant text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '
BEGIN
INSERT INTO "bolt_audit".tenant_retirement ("platform","tenant") VALUES (p_platform,p_tenant) ON CONFLICT DO NOTHING;
UPDATE "bolt_audit".tenant_retirement SET retired_at=coalesce(retired_at,clock_timestamp()) WHERE "platform"=p_platform AND "tenant"=p_tenant;
END ';
REVOKE ALL ON FUNCTION "bolt_audit".retire_tenant(text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".expire(p_platform text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '
DECLARE removed integer;
BEGIN
INSERT INTO "bolt_audit".maintenance(pid,xid,"platform",cutoff) VALUES(pg_backend_pid(),txid_current(),p_platform,statement_timestamp()-interval ''30 days'');
WITH expired AS (SELECT ctid FROM "bolt_audit".event WHERE "platform"=p_platform AND recorded_at<=statement_timestamp()-interval ''30 days'' ORDER BY recorded_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
DELETE FROM "bolt_audit".event WHERE ctid IN (SELECT ctid FROM expired);
GET DIAGNOSTICS removed = ROW_COUNT;
DELETE FROM "bolt_audit".maintenance WHERE pid=pg_backend_pid() AND xid=txid_current();
RETURN removed;
END ';
REVOKE ALL ON FUNCTION "bolt_audit".expire(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION "bolt_audit".purge_tenant(p_platform text,p_tenant text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '
DECLARE removed integer;
BEGIN
IF NOT EXISTS (SELECT 1 FROM "bolt_audit".tenant_retirement WHERE "platform"=p_platform AND "tenant"=p_tenant AND retired_at IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE=''BA104'', MESSAGE=''Retire the log namespace before purging it''; END IF;
INSERT INTO "bolt_audit".maintenance(pid,xid,"platform","tenant") VALUES(pg_backend_pid(),txid_current(),p_platform,p_tenant);
WITH doomed AS (SELECT ctid FROM "bolt_audit".event WHERE "platform"=p_platform AND "tenant"=p_tenant LIMIT 1000 FOR UPDATE)
DELETE FROM "bolt_audit".event WHERE ctid IN (SELECT ctid FROM doomed);
GET DIAGNOSTICS removed = ROW_COUNT;
DELETE FROM "bolt_audit".maintenance WHERE pid=pg_backend_pid() AND xid=txid_current();
RETURN removed;
END ';
REVOKE ALL ON FUNCTION "bolt_audit".purge_tenant(text,text) FROM PUBLIC;
