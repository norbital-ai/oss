import dedent from 'dedent';
import {
	NON_COLLECTION_INTERNALS,
	NON_TEMPORAL_SYSTEM_COLLECTIONS,
	SYSTEM_COLLECTIONS_INSERT_ONLY,
	SYSTEM_COLLECTIONS_WITHOUT_APPROVAL_LOCK,
	SYSTEM_COLLECTIONS_WITHOUT_OPS_GUARD,
	replicaExcludedTables as replicaExcludedFromFlags
} from '@norbital-ai/platform-utils/system/workspace-schema';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

const INTERNAL_TABLES = NON_COLLECTION_INTERNALS;

const sqlLiteralList = (names: Iterable<string>): string =>
	[...new Set(names)]
		.sort()
		.map((name) => `'${name.replaceAll("'", "''")}'`)
		.join(', ');

export type SchemaCollectionFlags = {
	readonly nonTemporal: Iterable<string>;
	readonly opsGuardExempt: Iterable<string>;
	readonly approvalLockExempt: Iterable<string>;
	readonly insertOnly: Iterable<string>;
};

function manifestExtensionFlag(
	manifest: NorbitalManifest,
	flag: 'history' | 'opsGuard' | 'approvalLock' | 'replica' | 'insertOnly',
	match: boolean
): string[] {
	return Object.entries(manifest.collections)
		.filter(([, collection]) => collection.extensions?.[flag] === match)
		.map(([name]) => name);
}

/**
 * Tables the ops guard skips: leftover internals, plus every collection that has not opted in.
 * System collections default to opted out; tenant collections default to opted in.
 */
export function opsGuardExemptCollections(manifest: NorbitalManifest): Set<string> {
	return new Set([
		...INTERNAL_TABLES,
		...SYSTEM_COLLECTIONS_WITHOUT_OPS_GUARD,
		...manifestExtensionFlag(manifest, 'opsGuard', false)
	]);
}

/**
 * Tables the approval-lock gate skips: leftover internals, plus every collection that opted out.
 */
export function approvalLockExemptCollections(manifest: NorbitalManifest): Set<string> {
	return new Set([
		...INTERNAL_TABLES,
		...SYSTEM_COLLECTIONS_WITHOUT_APPROVAL_LOCK,
		...manifestExtensionFlag(manifest, 'approvalLock', false)
	]);
}

/** Collections that reject UPDATE/DELETE. */
export function insertOnlyCollections(manifest: NorbitalManifest): Set<string> {
	return new Set([
		...SYSTEM_COLLECTIONS_INSERT_ONLY,
		...manifestExtensionFlag(manifest, 'insertOnly', true)
	]);
}

/** Tables omitted from the client replica DDL. */
export function replicaExcludedTables(manifest: NorbitalManifest): string[] {
	return replicaExcludedFromFlags(manifest.collections);
}

/**
 * Tables the temporal-history refresh skips: the leftover internals, plus whichever collections
 * have opted out of history.
 *
 * A different question from the ops guard — "does this table have a history relation" — and so
 * deliberately a different list. Sharing one was how ~17 system collections that do have history
 * tables ended up excluded from the drift repair that keeps those relations in step.
 */
const historyExemptTables = (nonTemporalCollections: Iterable<string>): string =>
	sqlLiteralList([...INTERNAL_TABLES, ...nonTemporalCollections]);

export function schemaCollectionFlags(manifest: NorbitalManifest): SchemaCollectionFlags {
	return {
		nonTemporal: nonTemporalCollections(manifest),
		opsGuardExempt: opsGuardExemptCollections(manifest),
		approvalLockExempt: approvalLockExemptCollections(manifest),
		insertOnly: insertOnlyCollections(manifest)
	};
}

/**
 * Every collection that has opted out of temporal history, read from the two places the flag is
 * declared: `SystemTableMeta.history` for system collections, and `ModelMetadata.history` for
 * tenant ones, which reaches here as `extensions.history` on the workspace manifest.
 *
 * The workspace manifest carries only tenant collections, which is why the system half is read
 * directly rather than looked for in it. Both halves are the same flag the migration generator
 * resolves, so the generated lineage and the runtime DDL cannot disagree about a table.
 */
export function nonTemporalCollections(manifest: NorbitalManifest): Set<string> {
	const names = new Set<string>(NON_TEMPORAL_SYSTEM_COLLECTIONS);
	for (const [name, collection] of Object.entries(manifest.collections)) {
		if (collection.extensions?.history === false) names.add(name);
	}
	return names;
}

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
    -- Float embedding nearest-neighbor (cosine / L2 / IP on vector(n)).
    -- Neon ships pgvector; PGlite replicas remap vector types to text and never create HNSW.
    CREATE EXTENSION IF NOT EXISTS "vector";

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

    -- Immutable date projection of a single canonical ISO date string.
    --
    -- The same STABLE-cast problem as norbital_daterange above, in the other place Postgres
    -- refuses a stable expression: a STORED generated column. A union column that projects
    -- \`(event ->> 'from_date')::date\` inline cannot be created at all. The projected text is
    -- always a canonical ISO date, whose parse does not depend on DateStyle, so declaring the
    -- wrapper immutable is honest. An absent or empty value projects NULL rather than failing,
    -- which is what a variant that does not carry the field needs.
    CREATE OR REPLACE FUNCTION norbital_date(value TEXT)
    RETURNS date
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $norbital_date$
      SELECT NULLIF(value, '')::date
    $norbital_date$;

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
    -- independent history trigger below; this trigger owns only the integer token.
    CREATE OR REPLACE FUNCTION _norbital_row_version() RETURNS TRIGGER AS $$
    BEGIN
      NEW.norbital_row_version := OLD.norbital_row_version + 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Native temporal history for managed Postgres providers. Norbital used to depend on the
    -- temporal_tables C extension, which Neon does not offer. This trigger preserves the subset
    -- of its contract Pod uses: transaction-time periods, one archived prior row per committed
    -- update/delete, same-transaction coalescing, and one-microsecond conflict adjustment.
    CREATE OR REPLACE FUNCTION _norbital_versioning() RETURNS TRIGGER AS $norbital_versioning$
    DECLARE
      history_table TEXT;
      existing_range TSTZRANGE;
      range_lower TIMESTAMPTZ;
      version_time TIMESTAMPTZ := CURRENT_TIMESTAMP;
      common_columns TEXT[];
    BEGIN
      IF TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
        RAISE TRIGGER_PROTOCOL_VIOLATED
          USING MESSAGE = '_norbital_versioning must be fired BEFORE ROW';
      END IF;
      IF TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
        RAISE TRIGGER_PROTOCOL_VIOLATED
          USING MESSAGE = '_norbital_versioning must be fired for INSERT, UPDATE, or DELETE';
      END IF;
      IF TG_NARGS <> 1 THEN
        RAISE INVALID_PARAMETER_VALUE
          USING MESSAGE = '_norbital_versioning expects exactly one history-table argument';
      END IF;

      history_table := TG_ARGV[0];
      IF TG_OP = 'INSERT' THEN
        NEW.norbital_sys_period := tstzrange(version_time, NULL, '[)');
        RETURN NEW;
      END IF;

      -- The original extension deliberately coalesced a row inserted/updated more than once in
      -- one transaction: there is no committed intermediate state to archive.
      IF OLD.xmin::text = (txid_current() % (2^32)::bigint)::text THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;

      existing_range := OLD.norbital_sys_period;
      IF existing_range IS NULL OR isempty(existing_range) OR NOT upper_inf(existing_range) THEN
        RAISE DATA_EXCEPTION
          USING MESSAGE = format('invalid norbital_sys_period on relation %I', TG_TABLE_NAME),
                DETAIL = 'valid periods must be non-empty and unbounded on the high side';
      END IF;
      range_lower := lower(existing_range);
      IF range_lower >= version_time THEN
        version_time := range_lower + interval '1 microsecond';
      END IF;

      IF to_regclass(format('%I.%I', TG_TABLE_SCHEMA, history_table)) IS NULL THEN
        RAISE UNDEFINED_TABLE
          USING MESSAGE = format('history relation %I.%I does not exist', TG_TABLE_SCHEMA, history_table);
      END IF;

      -- History and live schemas are validated before triggers are installed. Name columns
      -- explicitly so future generated columns remain generated instead of being assigned.
      SELECT array_agg(format('%I', live.attname) ORDER BY live.attnum)
        INTO common_columns
        FROM pg_attribute live
        JOIN pg_attribute history
          ON history.attrelid = format('%I.%I', TG_TABLE_SCHEMA, history_table)::regclass
         AND history.attname = live.attname
         AND NOT history.attisdropped
       WHERE live.attrelid = TG_RELID
         AND live.attnum > 0
         AND NOT live.attisdropped
         AND live.attname <> 'norbital_sys_period'
         AND history.attgenerated = '';

      EXECUTE format(
        'INSERT INTO %I.%I (%s, norbital_sys_period) VALUES ($1.%s, tstzrange($2, $3, ''[)''))',
        TG_TABLE_SCHEMA,
        history_table,
        array_to_string(common_columns, ', '),
        array_to_string(common_columns, ', $1.')
      ) USING OLD, range_lower, version_time;

      IF TG_OP = 'UPDATE' THEN
        NEW.norbital_sys_period := tstzrange(version_time, NULL, '[)');
        RETURN NEW;
      END IF;
      RETURN OLD;
    END;
    $norbital_versioning$ LANGUAGE plpgsql;

    -- CREATE TABLE ... LIKE loses PostgreSQL's declared array dimensionality metadata
    -- (attndims). Native history requires the tuple descriptor to match the live relation
    -- exactly, so build the history columns from
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

/**
 * Idempotent tenant internals applied after manifest DDL (tables + triggers).
 *
 * Tables live in system collections. What remains here is the version stamp, singleton seed
 * rows, leftover-notify cleanup, and the dynamic loops that attach triggers per collection —
 * history relations included, because those are typed copies of whichever tables opted in.
 */
export function schemaPostDdlSql(
	nonTemporal: Iterable<string>,
	extras?: Omit<SchemaCollectionFlags, 'nonTemporal'>
): string {
	const opsGuardExempt = sqlLiteralList(
		extras?.opsGuardExempt ?? [...SYSTEM_COLLECTIONS_WITHOUT_OPS_GUARD, ...INTERNAL_TABLES]
	);
	const approvalLockExempt = sqlLiteralList(
		extras?.approvalLockExempt ?? [...SYSTEM_COLLECTIONS_WITHOUT_APPROVAL_LOCK, ...INTERNAL_TABLES]
	);
	const insertOnly = [...new Set(extras?.insertOnly ?? SYSTEM_COLLECTIONS_INSERT_ONLY)].sort();
	const insertOnlyAttach = insertOnly
		.map(
			(name) => `
    DO $insert_only_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}$
    BEGIN
      IF to_regclass('public.${name.replaceAll("'", "''")}') IS NOT NULL THEN
        CREATE OR REPLACE FUNCTION _norbital_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}_insert_only() RETURNS trigger
        LANGUAGE plpgsql AS $insert_only$
        BEGIN
          RAISE EXCEPTION '${name.replaceAll("'", "''")} is insert-only';
        END;
        $insert_only$;
        DROP TRIGGER IF EXISTS _norbital_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}_insert_only ON ${name};
        CREATE TRIGGER _norbital_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}_insert_only
          BEFORE UPDATE OR DELETE ON ${name}
          FOR EACH ROW EXECUTE FUNCTION _norbital_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}_insert_only();
      END IF;
    END
    $insert_only_${name.replaceAll(/[^A-Za-z0-9_]/g, '_')}$;`
		)
		.join('\n');

	return dedent`
    CREATE TABLE IF NOT EXISTS _norbital_internal_schema (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Singleton rows for host-internal collections. The tables themselves are system
    -- collections; these inserts are data bootstrap after drizzle has created them.
    DO $seed_singletons$
    BEGIN
      IF to_regclass('public._norbital_sync_compaction') IS NOT NULL THEN
        INSERT INTO _norbital_sync_compaction (singleton)
          VALUES (TRUE)
          ON CONFLICT (singleton) DO NOTHING;
      END IF;
      IF to_regclass('public._norbital_automation_cursor') IS NOT NULL THEN
        INSERT INTO _norbital_automation_cursor (singleton)
          VALUES (TRUE)
          ON CONFLICT (singleton) DO NOTHING;
      END IF;
      IF to_regclass('public._norbital_sync_epoch') IS NOT NULL THEN
        INSERT INTO _norbital_sync_epoch (singleton)
          VALUES (TRUE)
          ON CONFLICT (singleton) DO NOTHING;
      END IF;
    END
    $seed_singletons$;

    -- The change feed is host-published after commit (\`wakeSync\`). Postgres no longer
    -- NOTIFYs; a LISTEN would pin Neon. Drop the leftover trigger on existing tenants.
    DO $drop_sync_notify$
    BEGIN
      IF to_regclass('public.sync_outbox') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS _norbital_sync_notify ON sync_outbox;
      END IF;
    END
    $drop_sync_notify$;
    DROP FUNCTION IF EXISTS _norbital_sync_notify();

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
      IF to_regclass('public.approval_request') IS NOT NULL
         AND to_regclass('public._approval_lock') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS _approval_lock_sync ON approval_request;
        CREATE TRIGGER _approval_lock_sync
          AFTER INSERT OR UPDATE OF locked_record_refs, status OR DELETE
          ON approval_request
          FOR EACH ROW EXECUTE FUNCTION _approval_lock_sync();
      END IF;
    END
    $approval_lock_sync$;
    ${insertOnlyAttach}

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
          AND c.relname NOT IN (
            ${approvalLockExempt}
          )
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
    -- Collections that opted out — every system collection by default — are skipped: their
    -- rows are written by paths other than collection_ops, which do not set norbital.via_ops.
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
            ${opsGuardExempt}
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

    -- Extension-backed temporal history. Every record table that opted in has a typed,
    -- same-shaped <table>_history relation. CREATE IF NOT EXISTS is intentionally
    -- non-destructive: schema migrations own both relations and must evolve them together.
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
            ${historyExemptTables(nonTemporal)}
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
          'CREATE TRIGGER _norbital_versioning BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION _norbital_versioning(%L)',
          tbl.table_name,
          history_table
        );
      END LOOP;
    END
    $refresh_versioning$;
`;
}
