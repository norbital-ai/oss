import { Effect } from 'effect';
import {
	logLiteral as lit,
	logName as q,
	logPath,
	logSpec,
	type AppendOnlyLogSpec
} from './spec.ts';

const eventContract = (spec: AppendOnlyLogSpec) =>
	[
		"jsonb_typeof(event)='object'",
		`event ?& ARRAY[${spec.envelope.required.map(lit).join(',')}]`,
		`${logPath(spec.envelope.id)}=id`,
		...spec.envelope.nonempty.map((field) => `coalesce(length(${logPath(field)}),0)>0`),
		...spec.envelope.enums.map(
			(entry) => `${logPath(entry.path)} IN (${entry.values.map(lit).join(',')})`
		),
		...spec.envelope.objects.map(
			(field) => `jsonb_typeof(${logPath(field, 'event', false)})='object'`
		),
		`occurred_at=(${logPath(spec.envelope.at)})::timestamptz`
	].join('\nAND ');

/** All native invariants derive from the serializable declaration, including privileged maintenance. */
export const logDdl = (input: AppendOnlyLogSpec) =>
	Effect.gen(function* () {
		const spec = yield* logSpec(input);
		const ns = q(spec.namespace),
			event = `${ns}.event`,
			retired = `${ns}.tenant_retirement`,
			maintenance = `${ns}.maintenance`;
		const scope = spec.scope.map(q),
			[partition = '', tenant = ''] = scope;
		const scopeArgs = spec.scope.map((field) => `p_${field}`);
		const scopes = scope.join(','),
			prefix = scope.length === 0 ? '' : `${scopes},`;
		const retain = `statement_timestamp()-interval '${spec.retention.days} days'`;
		const path = (parts: readonly string[]) => logPath(parts);
		const contract = eventContract(spec);
		const sql = [
			'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public',
			`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm' AND n.nspname='public') THEN RAISE EXCEPTION 'The log database requires pg_trgm in the public schema'; END IF; END $$`,
			`CREATE SCHEMA ${ns}`,
			`REVOKE ALL ON SCHEMA ${ns} FROM PUBLIC`
		];
		if (spec.retirement)
			sql.push(
				`CREATE TABLE ${retired} (${partition} text NOT NULL CHECK (${partition}<>''), ${tenant} text NOT NULL CHECK (${tenant}<>''), retired_at timestamptz CHECK (retired_at IS NULL OR isfinite(retired_at)), PRIMARY KEY (${partition},${tenant}))`,
				`REVOKE ALL ON TABLE ${retired} FROM PUBLIC`
			);
		sql.push(
			`CREATE TABLE ${event} (
${scope.map((field) => `${field} text NOT NULL CHECK (${field}<>'')`).join(',\n')}${scope.length === 0 ? '' : ','}
id text NOT NULL CHECK (id<>''),
occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
event jsonb NOT NULL CONSTRAINT event_check CHECK ((${contract}) IS TRUE),
payload_bytes integer GENERATED ALWAYS AS (octet_length((${logPath(spec.envelope.payload, 'event', false)})::text)) STORED NOT NULL,
document text GENERATED ALWAYS AS (event::text) STORED,
PRIMARY KEY (${prefix}id))`,
			`REVOKE ALL ON TABLE ${event} FROM PUBLIC`
		);
		const index = (name: string, fields: readonly string[], suffix = '') =>
			`CREATE INDEX ${q(name)} ON ${event} (${fields.join(',')})${suffix}`;
		sql.push(index('event_time', [...scope, 'occurred_at', 'id']));
		for (const entry of spec.indexes)
			sql.push(
				index(entry.name, [
					...scope,
					...entry.paths.map((field) => `(${path(field)})`),
					'occurred_at',
					'id'
				])
			);
		sql.push(
			index(
				'event_pending',
				[...scope, 'occurred_at', 'id'],
				` WHERE ${path(spec.pending.status)}=${lit(spec.pending.prepared)}`
			),
			`CREATE INDEX event_search ON ${event} USING gin (document public.gin_trgm_ops)`,
			index('event_retention', spec.retirement ? [partition, 'recorded_at'] : ['recorded_at', 'id'])
		);
		if (spec.retirement)
			sql.push(
				`CREATE TABLE ${maintenance} (
pid integer NOT NULL, xid bigint NOT NULL,
${partition} text NOT NULL CHECK (${partition}<>''), ${tenant} text, cutoff timestamptz,
PRIMARY KEY (pid,xid), CHECK ((${tenant} IS NOT NULL AND ${tenant}<>'' AND cutoff IS NULL)
OR (${tenant} IS NULL AND cutoff IS NOT NULL AND isfinite(cutoff))))`,
				`REVOKE ALL ON TABLE ${maintenance} FROM PUBLIC`
			);
		const unchanged = [...scope, 'id', 'occurred_at', 'recorded_at', 'event'];
		const deletion = spec.retirement
			? `EXISTS (SELECT 1 FROM ${maintenance} capability WHERE capability.pid=pg_backend_pid() AND capability.xid=txid_current()
AND capability.${partition}=OLD.${partition}
AND (capability.${tenant}=OLD.${tenant} OR (capability.${tenant} IS NULL AND OLD.recorded_at<=capability.cutoff)))`
			: `OLD.recorded_at<=clock_timestamp()-interval '${spec.retention.days} days'`;
		sql.push(
			`CREATE OR REPLACE FUNCTION ${ns}.immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
IF TG_OP='UPDATE' THEN
 IF ROW(${unchanged.map((field) => `NEW.${field}`).join(',')}) IS NOT DISTINCT FROM ROW(${unchanged.map((field) => `OLD.${field}`).join(',')}) THEN RETURN NEW; END IF;
END IF;
IF TG_OP='DELETE' THEN IF ${deletion} THEN RETURN OLD; END IF; END IF;
RAISE EXCEPTION USING ERRCODE='BA101', MESSAGE='Log events are immutable';
END $$`,
			`REVOKE ALL ON FUNCTION ${ns}.immutable() FROM PUBLIC`,
			`CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${event} FOR EACH ROW EXECUTE FUNCTION ${ns}.immutable()`,
			`CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ${event} FOR EACH STATEMENT EXECUTE FUNCTION ${ns}.immutable()`
		);
		const retireArgs = scopeArgs.slice(0, 2),
			retireMatch = `${partition}=${retireArgs[0]} AND ${tenant}=${retireArgs[1]}`;
		const fence = spec.retirement
			? `INSERT INTO ${retired} (${partition},${tenant}) VALUES (${retireArgs.join(',')}) ON CONFLICT DO NOTHING;
PERFORM 1 FROM ${retired} WHERE ${retireMatch} AND retired_at IS NULL FOR SHARE;
IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='BA103', MESSAGE='The log namespace is permanently retired'; END IF;`
			: '';
		const appendSignature = [...scopeArgs.map((field) => `${field} text`), 'p_events jsonb'].join(
			','
		);
		const appendTypes = [...scope.map(() => 'text'), 'jsonb'].join(',');
		sql.push(
			`CREATE OR REPLACE FUNCTION ${ns}.append(${appendSignature}) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item jsonb; written text;
BEGIN
${fence}
FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
 INSERT INTO ${event} AS existing (${prefix}id,occurred_at,event)
 VALUES (${scopeArgs.length === 0 ? '' : `${scopeArgs.join(',')},`}${logPath(spec.envelope.id, 'item')},(${logPath(spec.envelope.at, 'item')})::timestamptz,item)
 ON CONFLICT (${prefix}id) DO UPDATE SET id=EXCLUDED.id WHERE existing.event=EXCLUDED.event RETURNING existing.id INTO written;
 IF written IS NULL THEN RAISE EXCEPTION USING ERRCODE='BA102', MESSAGE='Log event id already has different content'; END IF;
END LOOP;
END $$`,
			`REVOKE ALL ON FUNCTION ${ns}.append(${appendTypes}) FROM PUBLIC`
		);
		if (spec.retirement) {
			const signature = retireArgs.map((field) => `${field} text`).join(',');
			sql.push(
				`CREATE OR REPLACE FUNCTION ${ns}.retire_tenant(${signature}) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
INSERT INTO ${retired} (${partition},${tenant}) VALUES (${retireArgs.join(',')}) ON CONFLICT DO NOTHING;
UPDATE ${retired} SET retired_at=coalesce(retired_at,clock_timestamp()) WHERE ${retireMatch};
END $$`,
				`REVOKE ALL ON FUNCTION ${ns}.retire_tenant(text,text) FROM PUBLIC`,
				`CREATE OR REPLACE FUNCTION ${ns}.expire(${scopeArgs[0]} text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
INSERT INTO ${maintenance}(pid,xid,${partition},cutoff) VALUES(pg_backend_pid(),txid_current(),${scopeArgs[0]},${retain});
WITH expired AS (SELECT ctid FROM ${event} WHERE ${partition}=${scopeArgs[0]} AND recorded_at<=${retain} ORDER BY recorded_at LIMIT ${spec.retention.batch} FOR UPDATE SKIP LOCKED)
DELETE FROM ${event} WHERE ctid IN (SELECT ctid FROM expired);
GET DIAGNOSTICS removed = ROW_COUNT;
DELETE FROM ${maintenance} WHERE pid=pg_backend_pid() AND xid=txid_current();
RETURN removed;
END $$`,
				`REVOKE ALL ON FUNCTION ${ns}.expire(text) FROM PUBLIC`,
				`CREATE OR REPLACE FUNCTION ${ns}.purge_tenant(${signature}) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
IF NOT EXISTS (SELECT 1 FROM ${retired} WHERE ${retireMatch} AND retired_at IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='BA104', MESSAGE='Retire the log namespace before purging it'; END IF;
INSERT INTO ${maintenance}(pid,xid,${partition},${tenant}) VALUES(pg_backend_pid(),txid_current(),${retireArgs.join(',')});
WITH doomed AS (SELECT ctid FROM ${event} WHERE ${retireMatch} LIMIT ${spec.retention.batch} FOR UPDATE)
DELETE FROM ${event} WHERE ctid IN (SELECT ctid FROM doomed);
GET DIAGNOSTICS removed = ROW_COUNT;
DELETE FROM ${maintenance} WHERE pid=pg_backend_pid() AND xid=txid_current();
RETURN removed;
END $$`,
				`REVOKE ALL ON FUNCTION ${ns}.purge_tenant(text,text) FROM PUBLIC`
			);
		}
		return sql.map((statement) => {
			if (!statement.startsWith('CREATE OR REPLACE FUNCTION ')) return statement;
			// Quote the complete generated body: JSON keys containing dollar delimiters remain data.
			const marker = ' AS $$',
				start = statement.indexOf(marker),
				end = statement.lastIndexOf('$$');
			return `${statement.slice(0, start)} AS ${lit(statement.slice(start + marker.length, end))}${statement.slice(end + 2)}`;
		});
	});

/** Non-destructive adoption of the former native log layout; immutable migration files preserve its exact prefix. */
export const logNativeUpgrade = (input: AppendOnlyLogSpec) =>
	Effect.gen(function* () {
		const spec = yield* logSpec(input),
			ddl = yield* logDdl(spec),
			table = `${q(spec.namespace)}.event`;
		return [
			`ALTER TABLE ${table} DROP CONSTRAINT event_check`,
			`ALTER TABLE ${table} ADD CONSTRAINT event_check CHECK ((${eventContract(spec)}) IS TRUE) NOT VALID`,
			`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS event_recorded_at_check`,
			`ALTER TABLE ${table} ADD CONSTRAINT event_recorded_at_check CHECK (isfinite(recorded_at)) NOT VALID`,
			...ddl.filter(
				(sql) => sql.startsWith('REVOKE ') || sql.startsWith('CREATE OR REPLACE FUNCTION ')
			),
			`DROP TRIGGER immutable ON ${table}`,
			`DROP TRIGGER immutable_truncate ON ${table}`,
			...ddl.filter((sql) => sql.startsWith('CREATE TRIGGER '))
		];
	});

/** Run in a later transaction: validation permits concurrent reads and ordinary writes. */
export const logNativeValidation = (input: AppendOnlyLogSpec) =>
	Effect.map(logSpec(input), (spec) => [
		`ALTER TABLE ${q(spec.namespace)}.event VALIDATE CONSTRAINT event_check`,
		`ALTER TABLE ${q(spec.namespace)}.event VALIDATE CONSTRAINT event_recorded_at_check`
	]);
