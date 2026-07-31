import dedent from 'dedent';

export const SCHEMA_FUNCTIONS_SQL = dedent`
    CREATE SCHEMA IF NOT EXISTS norbital_auth;
    CREATE SCHEMA IF NOT EXISTS public;

    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    -- Lets a GiST index (and therefore an EXCLUDE ... USING gist) carry plain-equality
    -- members such as uuid/text scalars beside a range member. Without it, an exclusion
    -- of the form \`(tenant_id WITH =, period WITH &&)\` cannot be created at all.
    CREATE EXTENSION IF NOT EXISTS "btree_gist";

    -- Immutable daterange projection of a date-range JSONB value.
    --
    -- Postgres rejects any STABLE expression in an index or EXCLUDE constraint, and a
    -- text -> date cast is STABLE (its result can depend on DateStyle). That makes the
    -- obvious inline form — daterange((r->>'start')::date, (r->>'end')::date, '[)') —
    -- unusable in a constraint. Date-range columns always store canonical UTC ISO
    -- instants, whose parse is DateStyle-independent, so this projection genuinely is
    -- immutable and is allowed to declare itself so.
    --
    -- Half-open [start, end): adjacent periods touch without overlapping. A missing or
    -- empty bound is unbounded, so an open-ended effective period overlaps everything after it.
    CREATE OR REPLACE FUNCTION norbital_daterange(payload JSONB)
    RETURNS daterange
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $norbital_daterange$
      SELECT daterange(
        NULLIF(payload->>'start', '')::date,
        NULLIF(payload->>'end', '')::date,
        '[)'
      )
    $norbital_daterange$;

    CREATE OR REPLACE FUNCTION build_repr_from_jsonb(payload JSONB)
    RETURNS TEXT
    LANGUAGE plpgsql
    AS $$
    DECLARE
      pair RECORD;
      repr TEXT := '';
      token TEXT;
      formatted_value TEXT;
      scalar_text TEXT;
    BEGIN
      FOR pair IN SELECT key, value FROM jsonb_each(payload) LOOP
        IF pair.key LIKE 'norbital_%' THEN
          CONTINUE;
        END IF;
        formatted_value := NULL;
        IF jsonb_typeof(pair.value) = 'boolean' THEN
          formatted_value := pair.value #>> '{}';
        ELSIF jsonb_typeof(pair.value) = 'string' THEN
          scalar_text := pair.value #>> '{}';
          formatted_value := scalar_text;
        ELSIF jsonb_typeof(pair.value) = 'number' THEN
          formatted_value := pair.value #>> '{}';
        ELSE
          CONTINUE;
        END IF;
        token := TRIM(BOTH FROM CONCAT_WS(' ', replace(pair.key, '_', ' '), formatted_value));
        IF token IS NULL OR token = '' THEN
          CONTINUE;
        END IF;
        repr := TRIM(BOTH FROM CONCAT_WS(' ', NULLIF(repr, ''), token));
      END LOOP;
      RETURN LEFT(repr, 8192);
    END;
    $$;

    CREATE OR REPLACE FUNCTION _approval_lock_gate() RETURNS TRIGGER AS $$
    DECLARE
      coll_name TEXT;
      row_id UUID;
      required_types TEXT[];
      conflict_ar UUID;
    BEGIN
      IF COALESCE(current_setting('norbital.approval_terminal_transition', true), '') = 'on' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;

      coll_name := TG_TABLE_NAME;
      row_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.norbital_id ELSE NEW.norbital_id END;
      required_types := CASE
        WHEN TG_OP = 'DELETE' THEN ARRAY['record_delete', 'record_mutation']
        ELSE ARRAY['record_mutation']
      END;

      SELECT approval_request_id INTO conflict_ar
      FROM _approval_lock
      WHERE collection_name = coll_name
        AND record_id = row_id
        AND lock_type = ANY(required_types)
      LIMIT 1;

      IF conflict_ar IS NOT NULL
         AND COALESCE(current_setting('norbital.approval_revision_request_id', true), '') <> conflict_ar::text THEN
        RAISE EXCEPTION 'record %/% has pending approval request %', coll_name, row_id, conflict_ar
          USING ERRCODE = 'N0LCK',
                DETAIL = format('collection_name=%s;record_id=%s;approval_request_id=%s', coll_name, row_id, conflict_ar);
      END IF;

      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$ LANGUAGE plpgsql;

    -- Sync-engine capture guard. Every write to a tenant collection table must pass
    -- through collection_ops, which opens the authoritative transaction and sets the
    -- transaction-local GUC \`norbital.via_ops\`. A stray direct write (no GUC) is
    -- rejected with SQLSTATE N0OPS so capture / audit / history / permission can never
    -- be silently bypassed. See collection_transaction.server.ts (the sole setter) and
    -- the seed executor, which is the one authorized bulk-load path that also sets it.
    CREATE OR REPLACE FUNCTION _ops_guard() RETURNS TRIGGER AS $$
    BEGIN
      IF COALESCE(current_setting('norbital.via_ops', true), '') <> 'on' THEN
        RAISE EXCEPTION 'write to "%" must go through collection_ops', TG_TABLE_NAME
          USING ERRCODE = 'N0OPS',
                DETAIL = format('table=%s;op=%s', TG_TABLE_NAME, TG_OP);
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$ LANGUAGE plpgsql;

    -- System-versioned temporal tables. Attached to every collection that has a
    -- <table>_history sibling, this owns all temporal bookkeeping so no code path can
    -- forget to version: on UPDATE/DELETE it archives the prior row to history with its
    -- system period closed at now(); on INSERT/UPDATE it opens a fresh period on the live
    -- row; on UPDATE it also increments norbital_row_version (the sync engine's optimistic
    -- concurrency token). Column-agnostic via a jsonb round-trip through the history row type.
    CREATE OR REPLACE FUNCTION _norbital_versioning() RETURNS TRIGGER AS $$
    DECLARE
      -- A transaction can begin before a concurrent writer, wait for that writer's row lock, then
      -- see the newer row after the writer commits. Transaction-start now() would precede that
      -- row's lower bound and make the closing tstzrange invalid. Timestamp at trigger execution.
      now_ts TIMESTAMPTZ := clock_timestamp();
      history_table TEXT := TG_TABLE_NAME || '_history';
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.norbital_sys_period := tstzrange(now_ts, NULL, '[)')::text;
        RETURN NEW;
      END IF;

      -- UPDATE or DELETE: archive the prior row, closing its period at now().
      EXECUTE format(
        'INSERT INTO %I SELECT (jsonb_populate_record(NULL::%I, $1)).*',
        history_table, history_table
      ) USING to_jsonb(OLD) - 'norbital_sys_period' || jsonb_build_object(
        'norbital_sys_period',
        tstzrange(lower(OLD.norbital_sys_period::tstzrange), now_ts, '[)')::text
      );

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;

      NEW.norbital_sys_period := tstzrange(now_ts, NULL, '[)')::text;
      NEW.norbital_row_version := OLD.norbital_row_version + 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
`;

/** Idempotent tenant internals applied after manifest DDL (tables + triggers). */
export const SCHEMA_POST_DDL_SQL = dedent`
    CREATE TABLE IF NOT EXISTS _norbital_internal_schema (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Sync-engine change feed. collection_ops writes one row per committed collection
    -- mutation in the same authoritative transaction as the data + audit + history, so
    -- the feed is never lost and never partial. \`xid\` records the writing transaction
    -- (pg_current_xact_id) so the tailer can apply a safe watermark: \`seq\` is assigned
    -- at INSERT but transactions commit out of order, so a row is only safe to emit once
    -- its xid drops below pg_snapshot_xmin(pg_current_snapshot()) — the oldest still
    -- in-flight transaction. Ordered/exactly-once delivery follows from an xid-band cursor.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      seq BIGSERIAL PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id UUID NOT NULL,
      action TEXT NOT NULL,
      row_version INTEGER,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      xid xid8 NOT NULL DEFAULT pg_current_xact_id()
    );
    CREATE INDEX IF NOT EXISTS sync_outbox_xid_seq_idx ON sync_outbox (xid, seq);
    -- Retention prunes by age, so the sweep needs to find old rows without a full scan.
    CREATE INDEX IF NOT EXISTS sync_outbox_occurred_at_idx ON sync_outbox (occurred_at);

    -- The compaction boundary: every change at or below \`pruned_through_seq\` has been discarded.
    --
    -- An unbounded change feed is not an option — it grows for the life of the tenant — but
    -- pruning it without recording where creates a far worse failure than growth. A client whose
    -- cursor points into the pruned range would resume from a feed that no longer contains its
    -- changes, see no error, and stay silently and permanently wrong. \`min(seq)\` cannot answer
    -- this either: prune the table empty and there is no minimum left to compare against.
    --
    -- So the boundary is durable and monotonic, and a cursor at or below it is answered with a
    -- reset instead of a diff: the replica is discarded and rebuilt. This is the same contract
    -- Electric states as its compaction boundary, and it is what makes retention safe.
    CREATE TABLE IF NOT EXISTS _norbital_sync_compaction (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      pruned_through_seq BIGINT NOT NULL DEFAULT 0,
      pruned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO _norbital_sync_compaction (singleton)
      VALUES (TRUE)
      ON CONFLICT (singleton) DO NOTHING;

    -- A durable identity for this physical tenant database. It survives ordinary migrations and
    -- deploys, but a restore/re-provision/reset creates a fresh value. Clients persist the last
    -- epoch they saw and discard their local replica when it changes; outbox sequence comparison
    -- alone is insufficient because a bulk reseed can overtake the pre-reset sequence immediately.
    CREATE TABLE IF NOT EXISTS _norbital_sync_epoch (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      epoch UUID NOT NULL DEFAULT uuidv7()
    );
    INSERT INTO _norbital_sync_epoch (singleton)
      VALUES (TRUE)
      ON CONFLICT (singleton) DO NOTHING;

    -- The change feed announces itself. Postgres queues NOTIFY inside the transaction and
    -- delivers it at COMMIT, which is exactly the moment a row becomes real — so a listener
    -- wakes on the commit instead of asking repeatedly whether one happened. An idle
    -- workspace therefore issues no queries at all, and a busy one wakes once per commit.
    -- The payload is the seq so a listener can tell whether it is already past this row.
    CREATE OR REPLACE FUNCTION _norbital_sync_notify() RETURNS trigger
    LANGUAGE plpgsql AS $sync_notify$
    BEGIN
      PERFORM pg_notify('norbital_sync', NEW.seq::text);
      RETURN NULL;
    END;
    $sync_notify$;

    DROP TRIGGER IF EXISTS _norbital_sync_notify ON sync_outbox;
    CREATE TRIGGER _norbital_sync_notify
      AFTER INSERT ON sync_outbox
      FOR EACH ROW EXECUTE FUNCTION _norbital_sync_notify();

    CREATE TABLE IF NOT EXISTS _approval_lock (
      norbital_id UUID PRIMARY KEY DEFAULT uuidv7(),
      approval_request_id UUID NOT NULL,
      lock_type TEXT NOT NULL CHECK (lock_type IN ('schema', 'record_delete', 'record_mutation')),
      collection_name TEXT NOT NULL,
      record_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (collection_name, record_id, lock_type)
    );

    DO $approval_lock_fk$
    BEGIN
      IF to_regclass('public.approval_request') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM pg_constraint
            WHERE conname = 'fk_approval_lock_request'
         ) THEN
        ALTER TABLE _approval_lock
          ADD CONSTRAINT fk_approval_lock_request
          FOREIGN KEY (approval_request_id)
          REFERENCES approval_request(norbital_id)
          ON DELETE CASCADE;
      END IF;
    END
    $approval_lock_fk$;

    CREATE OR REPLACE FUNCTION _approval_lock_sync() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        DELETE FROM _approval_lock WHERE approval_request_id = OLD.norbital_id;
        RETURN OLD;
      END IF;

      DELETE FROM _approval_lock WHERE approval_request_id = NEW.norbital_id;

      IF NEW.status IN ('APPROVED', 'REJECTED') THEN
        RETURN NEW;
      END IF;

      INSERT INTO _approval_lock (approval_request_id, lock_type, collection_name, record_id)
      SELECT
        NEW.norbital_id,
        elem->>'lock_type',
        elem->>'collection_name',
        (elem->>'record_id')::uuid
      FROM jsonb_array_elements(COALESCE(NEW.locked_record_refs, '[]'::jsonb)) AS elem
      WHERE elem ? 'lock_type'
        AND elem ? 'collection_name'
        AND elem ? 'record_id'
      ON CONFLICT DO NOTHING;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $approval_lock_sync$
    BEGIN
      IF to_regclass('public.approval_request') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS _approval_lock_sync ON approval_request;
        CREATE TRIGGER _approval_lock_sync
          AFTER INSERT OR UPDATE OF locked_record_refs, status OR DELETE
          ON approval_request
          FOR EACH ROW EXECUTE FUNCTION _approval_lock_sync();
      END IF;
    END
    $approval_lock_sync$;

    DO $refresh_approval_lock_gates$
    DECLARE
      tbl RECORD;
    BEGIN
      FOR tbl IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname !~ '_history$'
          AND c.relname NOT IN ('mutation_log', 'audit_event', '_approval_lock', '_norbital_internal_schema')
          AND EXISTS (
            SELECT 1
              FROM pg_attribute a
             WHERE a.attrelid = c.oid
               AND a.attname = 'norbital_id'
               AND NOT a.attisdropped
          )
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS _approval_lock_gate ON %I', tbl.table_name);
        EXECUTE format(
          'CREATE TRIGGER _approval_lock_gate BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION _approval_lock_gate()',
          tbl.table_name
        );
      END LOOP;
    END
    $refresh_approval_lock_gates$;

    -- Attach _ops_guard to every tenant collection table (BEFORE INSERT/UPDATE/DELETE).
    -- Platform/system tables are excluded: their rows are written by paths other than
    -- collection_ops (audit sink, integration-outbox drainer, onboarding, file delete),
    -- which do not set norbital.via_ops. Tenant collection tables are only ever written
    -- by collection_ops / approval_service (both open a collection transaction) or the
    -- seed executor — all of which set the GUC — so the guard never blocks a legitimate
    -- write while rejecting any stray direct one.
    DO $refresh_ops_guards$
    DECLARE
      tbl RECORD;
    BEGIN
      FOR tbl IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname !~ '_history$'
          AND c.relname NOT IN (
            'mutation_log', 'audit_event', '_approval_lock', '_norbital_internal_schema',
            '_norbital_sync_epoch',
            '__drizzle_migrations', 'sync_outbox', 'approval_request', 'requestor',
            'automation_run', 'user', 'team', 'policy', 'chat_session', 'integration_outbox',
            'notification', 'document_asset', 'team_members'
          )
          AND EXISTS (
            SELECT 1
              FROM pg_attribute a
             WHERE a.attrelid = c.oid
               AND a.attname = 'norbital_id'
               AND NOT a.attisdropped
          )
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS _ops_guard ON %I', tbl.table_name);
        EXECUTE format(
          'CREATE TRIGGER _ops_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION _ops_guard()',
          tbl.table_name
        );
      END LOOP;
    END
    $refresh_ops_guards$;

    INSERT INTO _norbital_internal_schema (version, name) VALUES (1, 'initial') ON CONFLICT DO NOTHING;

    -- History snapshots are a projection of the current collection schema, not the
    -- durable audit record. Rebuild after every migration so type/default/nullability
    -- changes cannot leave a stale row shape; audit_event remains the immutable log.
    DO $history_tables$
    DECLARE
      main_table text;
      history_table text;
    BEGIN
      FOR main_table IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname !~ '_history$'
          AND c.relname NOT IN (
            'mutation_log',
            'audit_event',
            '_approval_lock',
            '_norbital_internal_schema',
            '__drizzle_migrations'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'norbital_id'
              AND NOT a.attisdropped
          )
      LOOP
        history_table := main_table || '_history';
        EXECUTE format('DROP TABLE IF EXISTS %I', history_table);
        EXECUTE format(
          'CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS)',
          history_table,
          main_table
        );
      END LOOP;
    END
    $history_tables$;

    -- Attach the temporal-versioning trigger to every collection that now has a history
    -- table. Runs after the history tables exist so the to_regclass probe finds them, and
    -- after _ops_guard is attached; on UPDATE/DELETE the alphabetical fire order is
    -- _approval_lock_gate → _norbital_versioning → _ops_guard, so a blocked or unauthorized
    -- write is rejected and its archive rolls back with it. Idempotent (DROP IF EXISTS).
    DO $refresh_versioning$
    DECLARE
      tbl RECORD;
    BEGIN
      FOR tbl IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname !~ '_history$'
          AND to_regclass(format('public.%I', c.relname || '_history')) IS NOT NULL
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS _norbital_versioning ON %I', tbl.table_name);
        EXECUTE format(
          'CREATE TRIGGER _norbital_versioning BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION _norbital_versioning()',
          tbl.table_name
        );
      END LOOP;
    END
    $refresh_versioning$;
`;
