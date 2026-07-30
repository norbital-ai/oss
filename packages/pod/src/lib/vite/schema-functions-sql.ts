import dedent from 'dedent';

export const SCHEMA_FUNCTIONS_SQL = dedent`
    CREATE SCHEMA IF NOT EXISTS norbital_auth;
    CREATE SCHEMA IF NOT EXISTS public;

    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    CREATE EXTENSION IF NOT EXISTS "temporal_tables";
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

    -- Row versions are Pod's optimistic-concurrency token. Temporal row storage belongs to the
    -- temporal_tables extension; this trigger owns only the independent integer token.
    CREATE OR REPLACE FUNCTION _norbital_row_version() RETURNS TRIGGER AS $$
    BEGIN
      NEW.norbital_row_version := OLD.norbital_row_version + 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- CREATE TABLE ... LIKE loses PostgreSQL's declared array dimensionality metadata
    -- (attndims). The temporal_tables extension correctly requires the history tuple
    -- descriptor to match the live relation exactly, so build the history columns from
    -- pg_attribute instead. History is deliberately a data relation: keys, foreign keys,
    -- checks, and uniqueness remain constraints of the current-state table only.
    CREATE OR REPLACE FUNCTION _norbital_create_history_table(
      base_table REGCLASS,
      history_table TEXT
    ) RETURNS VOID
    LANGUAGE plpgsql
    AS $norbital_create_history_table$
    DECLARE
      column_definitions TEXT;
    BEGIN
      IF to_regclass(format('public.%I', history_table)) IS NOT NULL THEN
        RETURN;
      END IF;

      SELECT string_agg(
        format(
          '%I %s%s%s%s%s',
          attribute.attname,
          format_type(attribute.atttypid, attribute.atttypmod),
          CASE
            WHEN attribute.attndims > 1 THEN repeat('[]', attribute.attndims - 1)
            ELSE ''
          END,
          CASE
            WHEN attribute.attcollation <> 0
             AND attribute.attcollation <> data_type.typcollation
              THEN format(' COLLATE %s', attribute.attcollation::regcollation)
            ELSE ''
          END,
          CASE WHEN attribute.attnotnull THEN ' NOT NULL' ELSE '' END,
          CASE
            WHEN attribute.attgenerated <> '' THEN format(
              ' GENERATED ALWAYS AS (%s) STORED',
              pg_get_expr(default_value.adbin, default_value.adrelid)
            )
            WHEN default_value.adbin IS NOT NULL THEN format(
              ' DEFAULT %s',
              pg_get_expr(default_value.adbin, default_value.adrelid)
            )
            ELSE ''
          END
        ),
        ', ' ORDER BY attribute.attnum
      )
      INTO column_definitions
      FROM pg_attribute attribute
      JOIN pg_type data_type ON data_type.oid = attribute.atttypid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attrelid = base_table
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

      IF column_definitions IS NULL THEN
        RAISE EXCEPTION 'cannot create temporal history for missing or empty relation %', base_table;
      END IF;

      EXECUTE format('CREATE TABLE %I (%s)', history_table, column_definitions);
    END;
    $norbital_create_history_table$;
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

    -- The event-automation consumer is tenant-wide and durable. It is independent of browser
    -- stream cursors, so reconnecting clients can never duplicate automation dispatch.
    CREATE TABLE IF NOT EXISTS _norbital_automation_cursor (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      xid xid8 NOT NULL DEFAULT '0'::xid8,
      seq BIGINT NOT NULL DEFAULT 0
    );
    INSERT INTO _norbital_automation_cursor (singleton)
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

    -- How far the automation dispatcher has consumed the change feed.
    --
    -- Collection-event automations are effects, so they must fire exactly once off committed
    -- state, and a host restart must not re-run everything the feed still holds. The cursor is the
    -- same (xid, seq) pair the sync stream uses and is advanced only after a batch has dispatched,
    -- so a crash mid-batch repeats that batch rather than skipping it.
    CREATE TABLE IF NOT EXISTS _norbital_automation_cursor (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      xid TEXT NOT NULL DEFAULT '0',
      seq TEXT NOT NULL DEFAULT '0',
      pumped_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO _norbital_automation_cursor (singleton)
      VALUES (TRUE)
      ON CONFLICT (singleton) DO NOTHING;

    -- The change feed announces itself. Postgres queues NOTIFY inside the transaction and
    -- delivers it at COMMIT, which is exactly the moment a row becomes real — so a listener
    -- wakes on the commit instead of asking repeatedly whether one happened. An idle
    -- workspace therefore issues no queries at all.
    --
    -- Once per STATEMENT, not once per row. A bulk write is a single INSERT that appends
    -- thousands of outbox rows, and per-row notification turned that into thousands of
    -- deliveries — every one of them fanned out to every open stream on this database, each
    -- waking to run the same catch-up query against the same committed state. The wake-ups
    -- carry no information the first already carried: the feed is read from a cursor, so one
    -- listener pass drains everything the statement wrote.
    --
    -- The transition table gives the statement's rows in one place. The payload is the highest
    -- seq it appended, which is the only value that stays correct under coalescing — a listener
    -- past it is past every row in the batch. Nothing reads the payload today; it is there so a
    -- listener that wants to skip a catch-up can, without changing the trigger.
    CREATE OR REPLACE FUNCTION _norbital_sync_notify() RETURNS trigger
    LANGUAGE plpgsql AS $sync_notify$
    DECLARE
      latest_seq BIGINT;
    BEGIN
      SELECT MAX(seq) INTO latest_seq FROM _norbital_sync_inserted;
      IF latest_seq IS NOT NULL THEN
        PERFORM pg_notify('norbital_sync', latest_seq::text);
      END IF;
      RETURN NULL;
    END;
    $sync_notify$;

    DROP TRIGGER IF EXISTS _norbital_sync_notify ON sync_outbox;
    CREATE TRIGGER _norbital_sync_notify
      AFTER INSERT ON sync_outbox
      REFERENCING NEW TABLE AS _norbital_sync_inserted
      FOR EACH STATEMENT EXECUTE FUNCTION _norbital_sync_notify();

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

    -- One live invitation per address, enforced by the database rather than by a read-then-write.
    -- Two accepts racing on the same email would otherwise both see "no user yet" and both create
    -- one; the partial unique index makes the second INSERT fail instead, and the loser re-reads.
    -- The predicate scopes it to live rows, so an address can be re-invited after leaving.
    DO $invitation_guard$
    BEGIN
      IF to_regclass('public.invitation') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS invitation_live_email_unique
          ON invitation (email) WHERE consumed_at IS NULL;
      END IF;
    END
    $invitation_guard$;

    -- Agent transcripts are append-only. The unique sequence makes restart/resume deterministic;
    -- the trigger closes direct-SQL paths as well as the collection-operation surface.
    DO $agent_transcript$
    BEGIN
      IF to_regclass('public.agent_run_step') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS agent_run_step_run_sequence_unique
          ON agent_run_step (automation_run_id, sequence);
        CREATE OR REPLACE FUNCTION _norbital_agent_step_insert_only() RETURNS trigger
        LANGUAGE plpgsql AS $agent_step$
        BEGIN
          RAISE EXCEPTION 'agent_run_step is insert-only';
        END;
        $agent_step$;
        DROP TRIGGER IF EXISTS _norbital_agent_step_insert_only ON agent_run_step;
        CREATE TRIGGER _norbital_agent_step_insert_only
          BEFORE UPDATE OR DELETE ON agent_run_step
          FOR EACH ROW EXECUTE FUNCTION _norbital_agent_step_insert_only();
      END IF;
    END
    $agent_transcript$;

    -- audit_event is the append-only action log. Temporal history stores row states; audit_event
    -- stores who did what and must never be rewritten or repurposed as a rollback source.
    DO $audit_event_insert_only$
    BEGIN
      IF to_regclass('public.audit_event') IS NOT NULL THEN
        CREATE OR REPLACE FUNCTION _norbital_audit_event_insert_only() RETURNS trigger
        LANGUAGE plpgsql AS $audit_event$
        BEGIN
          RAISE EXCEPTION 'audit_event is insert-only';
        END;
        $audit_event$;
        DROP TRIGGER IF EXISTS _norbital_audit_event_insert_only ON audit_event;
        CREATE TRIGGER _norbital_audit_event_insert_only
          BEFORE UPDATE OR DELETE ON audit_event
          FOR EACH ROW EXECUTE FUNCTION _norbital_audit_event_insert_only();
      END IF;
    END
    $audit_event_insert_only$;

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
	          AND c.relname NOT IN ('audit_event', '_approval_lock', '_norbital_internal_schema')
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
	            'audit_event', '_approval_lock', '_norbital_internal_schema',
	            '_norbital_sync_epoch', '_norbital_automation_cursor',
	            '__drizzle_migrations', 'sync_outbox', 'approval_request', 'requestor',
	            'automation_run', 'agent_run_step', 'user', 'team', 'policy', 'integration_outbox',
	            'notification_outbox', 'notification', 'document_asset', 'team_members',
	            'invitation', 'host_event_outbox'
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

    -- Extension-backed temporal history. Every record table has a typed, same-shaped
    -- <table>_history relation. CREATE IF NOT EXISTS is intentionally non-destructive:
    -- schema migrations own both relations and must evolve them together.
    DO $refresh_versioning$
    DECLARE
      tbl RECORD;
      history_table TEXT;
    BEGIN
      FOR tbl IN
        SELECT c.oid AS table_oid, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname !~ '_history$'
          AND c.relname NOT IN (
            'audit_event', 'agent_run_step', 'sync_outbox', '_approval_lock',
            '_norbital_internal_schema', '_norbital_sync_epoch',
            '_norbital_automation_cursor', '__drizzle_migrations', 'host_event_outbox'
          )
          AND EXISTS (
            SELECT 1
              FROM pg_attribute a
             WHERE a.attrelid = c.oid
               AND a.attname = 'norbital_id'
               AND NOT a.attisdropped
          )
      LOOP
        history_table := tbl.table_name || '_history';
        PERFORM _norbital_create_history_table(tbl.table_oid::regclass, history_table);
        IF EXISTS (
          SELECT 1
          FROM (
            SELECT attname, atttypid, atttypmod, attndims, attcollation, attnotnull
              FROM pg_attribute
             WHERE attrelid = tbl.table_oid
               AND attnum > 0
               AND NOT attisdropped
          ) current_column
          FULL JOIN (
            SELECT attname, atttypid, atttypmod, attndims, attcollation, attnotnull
              FROM pg_attribute
             WHERE attrelid = to_regclass(format('public.%I', history_table))
               AND attnum > 0
               AND NOT attisdropped
          ) history_column USING (attname)
          WHERE current_column.attname IS NULL
             OR history_column.attname IS NULL
             OR current_column.atttypid <> history_column.atttypid
             OR current_column.atttypmod <> history_column.atttypmod
             OR current_column.attndims <> history_column.attndims
             OR current_column.attcollation <> history_column.attcollation
             OR current_column.attnotnull <> history_column.attnotnull
        ) THEN
          RAISE EXCEPTION 'temporal history schema mismatch for %', tbl.table_name
            USING HINT = format(
              'Apply every column migration to both %I and %I',
              tbl.table_name,
              history_table
            );
        END IF;
        EXECUTE format(
          'CREATE INDEX IF NOT EXISTS %I ON %I (norbital_id, norbital_row_version DESC)',
          history_table || '_record_version_idx',
          history_table
        );
        EXECUTE format('DROP TRIGGER IF EXISTS _norbital_row_version ON %I', tbl.table_name);
        EXECUTE format(
          'CREATE TRIGGER _norbital_row_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION _norbital_row_version()',
          tbl.table_name
        );
        EXECUTE format('DROP TRIGGER IF EXISTS _norbital_versioning ON %I', tbl.table_name);
        EXECUTE format(
          'CREATE TRIGGER _norbital_versioning BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION versioning(%L, %L, true)',
          tbl.table_name,
          'norbital_sys_period',
          history_table
        );
      END LOOP;
    END
    $refresh_versioning$;
`;
