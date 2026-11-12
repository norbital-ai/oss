import { Effect, Predicate, Schema } from 'effect';
import { UUID_PATTERN } from '@norbital-ai/std/id';
// Committed history is scoped by current reader authority and shows the fields of the output the read names; pending
// proposals append no revisions.
import type { Json } from '../../decl/values.ts';
import type { Bindings, Reader, Sql } from '../contracts.ts';
import type { Pred, FieldSpec } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { catalog_of } from '../access/pred.ts';
import { historyArms, viewOutput } from '../access/authority.ts';
import { or } from '../access/pred.ts';
import { catalog_for, exposure_of, exposed_field, q, DEFAULT_OUTPUT, SYSTEM_COLUMNS, SYSTEM_COLUMN_SET } from '@norbital-ai/store';
import { grant_sql, canonical } from '@norbital-ai/store';
import { resolverOf } from './reader.ts';
import { open_sql } from '../approvals/sql.ts';
import { acknowledgements } from '../audit-retention.ts';
import { from_store } from '../../protocol/errors.ts';
import {
	HistorySchema,
	historyChanges,
	historyKinds,
	compatibleHistoryValue,
	type HistoricalValue
} from './history-schema.ts';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const isTrue = (p: Pred) => p.t === 'const' && p.value;
const HistoryRows = Schema.Array(
	Schema.Struct({
		collection: Schema.String,
		revision: Schema.Int,
		at: Schema.NullOr(Schema.String),
		actor: Schema.NullOr(Schema.String),
		op: Schema.String,
		cause: Schema.String,
		restored_from: Schema.NullOr(Schema.Int),
		meta: Schema.Struct({
			schema: Schema.String,
			full: Schema.optionalKey(Schema.Boolean),
			id: Schema.optionalKey(Schema.Json),
			revision: Schema.optionalKey(Schema.Json),
			created_at: Schema.optionalKey(Schema.Json),
			created_by: Schema.optionalKey(Schema.Json),
			updated_at: Schema.optionalKey(Schema.Json),
			updated_by: Schema.optionalKey(Schema.Json)
		}),
		changes: Schema.Record(Schema.String, Schema.Json),
		request: Schema.NullOr(Schema.String),
		request_state: Schema.NullOr(Schema.String)
	})
);
export const read_history = Effect.fn('Bolt.read_history')(function* (
	db: TenantDb,
	m: EngineManifest,
	read: Extract<
		ReadIR,
		{
			kind: 'history';
		}
	>,
	reader: Reader,
	bindings: Bindings
) {
	const cat = catalog_of(m),
		output =
			read.output ??
			(reader.as === 'caller' && !reader.authority.admin
				? (viewOutput(m, reader.authority, read.model) ?? DEFAULT_OUTPUT)
				: DEFAULT_OUTPUT),
		c = yield* catalog_for(cat, read.model, output).pipe(
			Effect.flatMap((view) => exposure_of(view, read.model)),
			Effect.mapError(from_store)
		),
		id = read.id;
	if (!UUID_PATTERN.test(id)) return read.full === true || read.view === true ? null : [];
	const at = read.at;
	const params: Json[] = [read.model, id];
	const cut =
		at === undefined
			? ''
			: at._tag === 'Instant'
				? (params.push(at.instant), 'AND h.at <= $3::timestamptz')
				: at._tag === 'Revision'
					? (params.push(at.revision), 'AND h.revision <= $3::int')
					: (params.push(at.before),
						// the request's checkpoint: the record's revision before its provisional change (none: it created it)
						`AND h.revision <= coalesce((SELECT (r->>'before')::int FROM bolt_approvals x CROSS JOIN LATERAL jsonb_array_elements(x.records) r WHERE x.id = $3::uuid AND r->>'collection' = $1 AND r->>'id' = $2::text LIMIT 1), 0)`);
	const statements: Sql[] = [
		{
			text: `WITH visible AS (SELECT source.*,source.changes-ARRAY(
				SELECT DISTINCT unnest(bolt_history_purge_fields(source.meta->>'schema',p.collection,p.purge)) FROM bolt_audit_erase p WHERE p.mode='anonymise'
				AND bolt_history_matches(source.collection,source.meta,p.collection) AND p.record=source.record AND source.revision<p.revision) AS sanitised
			FROM bolt_history source LEFT JOIN bolt_history_schema definition ON definition.id::text=source.meta->>'schema'
			WHERE source.record=$2::uuid AND (source.collection=$1 OR definition.lineage IN (
				SELECT s.lineage FROM bolt_history_current c JOIN bolt_history_schema s ON s.id=c.schema WHERE c.model=$1 AND c.active)) AND NOT EXISTS (
				SELECT 1 FROM bolt_audit_erase p WHERE p.mode='remove' AND bolt_history_matches(source.collection,source.meta,p.collection) AND p.record=source.record
				AND source.revision<=p.revision AND NOT (p.keep_marker AND source.revision=p.revision)))
			SELECT h.collection, h.revision, to_char(h.at AT TIME ZONE 'UTC', ${ISO}) AS at, h.actor, h.op, h.cause, h.restored_from, h.meta,
			(SELECT coalesce(jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='number' AND
				coalesce(s.definition->'fields'->e.key->>'kind',s.definition->'computed'->e.key->>'kind') IN ('decimal','money','sum')
				THEN to_jsonb(e.value #>> '{}')
				WHEN jsonb_typeof(e.value)='string' AND s.definition->'fields'->e.key->>'kind'='period'
				AND pg_input_is_valid(e.value #>> '{}',CASE WHEN s.definition->'fields'->e.key->>'of'='date' THEN 'daterange' ELSE 'tstzrange' END) THEN
					CASE WHEN s.definition->'fields'->e.key->>'of'='date' THEN jsonb_build_object(
						'from',lower((e.value #>> '{}')::daterange),'to',upper((e.value #>> '{}')::daterange)-1)
					ELSE jsonb_build_object('start',to_char(lower((e.value #>> '{}')::tstzrange) AT TIME ZONE 'UTC',${ISO}),
						'end',to_char(upper((e.value #>> '{}')::tstzrange) AT TIME ZONE 'UTC',${ISO})) END
				ELSE e.value END),'{}'::jsonb) FROM jsonb_each(h.sanitised) e) AS changes,
			h.request::text AS request, ap.state AS request_state
			FROM visible h LEFT JOIN bolt_approvals ap ON ap.id = h.request LEFT JOIN bolt_history_schema s ON s.id::text=h.meta->>'schema'
		WHERE (h.sanitised<>'{}'::jsonb OR h.cause='erased' OR h.changes='{}'::jsonb) ${cut} ORDER BY h.revision`,
			params
		}
	];
	const auth = reader.as === 'caller' && !reader.authority.admin ? reader.authority : null;
	const self: Pred = { t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Lit', value: id } };
	const granted = auth === null ? [] : historyArms(auth, read.model, output);
	if (auth !== null) {
		if (granted.length === 0) return read.full === true || read.view === true ? null : [];
		// grant predicates, so compiled raw; a requestor variable in them resolves against the caller
		statements.push(
			{ text: `SELECT 1 FROM ${q(c.model.name)} WHERE id = $1::uuid`, params: [id] },
			yield* grant_sql(
				cat,
				read.model,
				{ t: 'and', of: [or(granted.map((arm) => arm.where)), self] },
				{ resolve: resolverOf(bindings, auth), tz: bindings.tz }
			).pipe(Effect.mapError(from_store))
		);
	}
	const versionsAt = statements.length;
	statements.push({
		text: `SELECT s.id::text,s.lineage::text,s.model,s.definition,s.fields,
			EXISTS(SELECT 1 FROM bolt_history_current c WHERE c.schema=s.id AND c.model=$1 AND c.active) AS current FROM bolt_history_schema s
			WHERE s.lineage IN (SELECT v.lineage FROM bolt_history_current c JOIN bolt_history_schema v ON v.id=c.schema WHERE c.model=$1 AND c.active)`,
		params: [read.model]
	});
	const res = yield* db.read(statements);
	if (auth !== null) {
		const existence = res[1], scope = res[2];
		if (existence === undefined || scope === undefined)
			return yield* BoltError.make('corrupt', 'decode', 'The history admission read returned an incomplete answer.');
		const exists = existence.rows.length > 0;
		// a live row needs the history scope; a deleted one, an unconditional grant of the output (rule 17)
		const visible = exists ? scope.rows.length > 0 : granted.some((a) => isTrue(a.where));
		if (!visible) return read.full === true || read.view === true ? null : [];
	}
	const versionRows = res[versionsAt], historyRows = res[0];
	if (versionRows === undefined || historyRows === undefined)
		return yield* BoltError.make('corrupt', 'decode', 'The history read returned an incomplete answer.');
	const versions = yield* Schema.decodeUnknownEffect(Schema.Array(HistorySchema), { onExcessProperty: 'error' })(
		versionRows.rows
	).pipe(Effect.mapError((error) => BoltError.make('schema', 'decode', error.message)));
	const byId = new Map(versions.map((version) => [version.id, version]));
	const current = versions.find((version) => version.current === true);
	if (current === undefined || current.model !== read.model)
		return yield* BoltError.make('schema', 'decode', `History requires a registered current schema for ${read.model}.`);
	for (const version of versions) {
		const identities = new Set<string>();
		const declared = Object.keys({ ...version.definition.fields, ...version.definition.computed });
		if (Object.keys(version.fields).length !== declared.length)
			return yield* BoltError.make('schema', 'decode', `History schema ${version.id} has incomplete field metadata.`);
		for (const field of declared) {
			const identity = version.fields[field];
			if (identity === undefined || !UUID_PATTERN.test(identity) || identities.has(identity))
				return yield* BoltError.make('schema', 'decode', `History schema ${version.id} has invalid field identities.`);
			identities.add(identity);
		}
	}
	const currentKinds = historyKinds(current);
	const convert = (value: Json, before: FieldSpec, after: FieldSpec) =>
		compatibleHistoryValue(value, before, after, m.custom_fields);
	const currentFields = new Map(
		Object.entries(current.fields).map(([field, identity]) => [identity, field])
	);
	const canSeeRemoved =
		reader.as === 'workspace' ||
		(reader.authority.admin && output === 'default' && c.fields === 'all');
	const visibleField = (identity: string, stored: HistoricalValue) => {
		if (reader.as === 'workspace' || SYSTEM_COLUMN_SET.has(stored.field)) return true;
		const archived = stored.version.definition.fields[stored.field] ?? stored.version.definition.computed?.[stored.field];
		if (archived === undefined) return false;
		const field = currentFields.get(identity);
		if (field !== undefined) return exposed_field(c, field);
		return canSeeRemoved && !(Predicate.isReadonlyObject(archived) && archived['hidden'] === true);
	};
	const state = new Map<string, HistoricalValue>();
	const rows = yield* Schema.decodeUnknownEffect(HistoryRows, { onExcessProperty: 'error' })(historyRows.rows).pipe(
		Effect.mapError((error) => BoltError.make('schema', 'decode', error.message))
	);
	const revisions = yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
		const meta = row.meta;
		const version = byId.get(meta.schema);
		if (version === undefined || version.model !== row.collection)
			return yield* BoltError.make('schema', 'decode', `History revision ${row.revision} has no matching registered schema.`);
		const changes = historyChanges(version, row.changes);
		if (changes instanceof BoltError) return yield* changes;
		const previous = new Map(state);
		if (row.op === 'create' || row.cause === 'erased' || meta.full === true) state.clear();
		for (const [identity, value] of changes) state.set(identity, value);
		for (const field of SYSTEM_COLUMNS) {
			const value = meta[field];
			if (value !== undefined) state.set(`system:${field}`, { version, field, value });
		}
		if (row.op === 'delete') state.clear();
		const actor = row.actor;
		const colon = actor?.indexOf(':') ?? -1;
		const changed = Object.fromEntries(
			[...changes]
				.filter(
					([identity, value]) =>
						visibleField(identity, value) &&
						(meta.full !== true ||
							canonical(previous.get(identity)?.value) !== canonical(value.value))
				)
				.map(([, value]) => [value.field, value.value])
		);
		const incompatible = [...state].flatMap(([identity, value]) => {
			if (!visibleField(identity, value) || SYSTEM_COLUMN_SET.has(value.field)) return [];
			const field = currentFields.get(identity);
			const kind = field === undefined ? undefined : currentKinds[field];
			const before = historyKinds(value.version)[value.field];
			return kind === undefined || before === undefined ||
				convert(
					value.value,
					before,
					kind
				) === undefined
				? [value.field]
				: [];
		});
		return {
			revision: row.revision,
			at: row.at,
			cause: row.cause,
			restored_from: row.restored_from,
			/** The approval request this revision belongs to: its provisional change, a reviewer's edit, or its rollback. */
			approval:
				row.request !== null
					? { request: row.request, state: row.request_state }
					: null,
			changed,
			schema_version: version.id,
			incompatible,
			/** Whether the whole revision still projects into today's representation. */
			valid: incompatible.length === 0,
			actor:
				actor === null || colon < 0
					? null
					: { kind: actor.slice(0, colon), id: actor.slice(colon + 1) }
		};
	}));
	if (read.full !== true && read.view !== true) return revisions;
	const last = revisions.at(-1);
	if (last === undefined || state.size === 0) return null;
	if (read.view === true && at?._tag === 'Revision' && last.revision !== at.revision) return null;
	const definition = byId.get(last.schema_version);
	if (definition === undefined)
		return yield* BoltError.make('schema', 'decode', 'The selected history schema is missing.');
	const kinds = historyKinds(definition);
	const values: Record<string, Json> = { id, revision: last.revision };
	const fields: Record<string, FieldSpec> = {};
	const compatible: Record<string, Json> = { id, revision: last.revision };
	const incompatible: string[] = [];
	for (const [identity, value] of state) {
		if (!visibleField(identity, value)) continue;
		const original = SYSTEM_COLUMN_SET.has(value.field) ? value.field
			: Object.entries(definition.fields).find(([, id]) => id === identity)?.[0];
		if (original === undefined) continue;
		values[original] = value.value;
		const oldKind =
			kinds[original] ??
			historyKinds(value.version)[value.field];
		if (oldKind !== undefined) fields[original] = oldKind;
		if (SYSTEM_COLUMN_SET.has(original)) {
			compatible[original] = value.value;
			continue;
		}
		const field = currentFields.get(identity);
		const kind = field === undefined ? undefined : currentKinds[field];
		const converted = kind === undefined || oldKind === undefined
			? undefined : convert(value.value, oldKind, kind);
		if (field === undefined || converted === undefined) incompatible.push(original);
		else compatible[field] = converted;
	}
	if (read.view === true)
		return {
			model: read.model,
			record: id,
			revision: last.revision,
			at: last.at,
			schema_version: last.schema_version,
			fields: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(canonical(fields)),
			values,
			compatible,
			incompatible
		};
	return compatible;
});
/**
 * Keeps open approval checkpoints, unacknowledged audit history, the newest revisions and erased audit markers. The oldest kept revision becomes
 * its anchor: the full row folded from its last schema snapshot, recorded as a create, so every kept revision still rebuilds (and
 * so stays restorable) — never an open restore point.
 */
export const prune_history = Effect.fn('Bolt.prune_history')(function* (
	db: TenantDb,
	keep: number = 256
) {
	// acknowledgements waiting for the next commit statement ride on this one: their history may go now
	const acks = [...acknowledgements(db)];
	const res = yield* db.write(
		{
			text: `WITH acknowledged AS (UPDATE bolt_audit_receipt SET acknowledged_at=clock_timestamp()
	WHERE operation IN (SELECT jsonb_array_elements_text($2::jsonb)) AND acknowledged_at IS NULL AND expired_at IS NULL RETURNING operation),
admitted AS MATERIALIZED (
	SELECT bolt_assert(NOT EXISTS (SELECT 1 FROM bolt_history h LEFT JOIN bolt_history_schema s ON s.id::text=h.meta->>'schema'
		WHERE s.id IS NULL OR s.model<>h.collection), 'schema', 'History requires registered schema versions before retention') AS valid),
held AS MATERIALIZED (
	SELECT DISTINCT entry->>'collection' AS collection, entry->>'id' AS record
	FROM bolt_approvals a CROSS JOIN LATERAL jsonb_array_elements(a.records) entry
	WHERE ${open_sql('a.state', true)}),
history AS MATERIALIZED (
	SELECT h.*,s.lineage::text AS lineage FROM bolt_history h
	JOIN bolt_history_schema s ON s.id::text=h.meta->>'schema'),
ranked AS (
	SELECT lineage, collection, record, revision, op, cause, row_number() OVER (PARTITION BY lineage, record ORDER BY revision DESC) AS rn
	FROM history h WHERE NOT EXISTS (
		SELECT 1 FROM history pending LEFT JOIN bolt_audit_receipt r ON r.operation=pending.operation
		WHERE pending.lineage=h.lineage AND pending.record=h.record AND pending.operation IS NOT NULL
		AND r.acknowledged_at IS NULL AND r.expired_at IS NULL AND r.operation NOT IN (SELECT operation FROM acknowledged))
	AND NOT EXISTS (SELECT 1 FROM held WHERE bolt_history_matches(h.collection,h.meta,held.collection) AND held.record=h.record::text)),
oldest AS (SELECT DISTINCT ON (x.lineage, x.record) x.lineage, x.collection, x.record, x.revision, x.op FROM ranked x
	WHERE x.rn <= $1 AND x.cause <> 'erased'
	AND EXISTS (SELECT 1 FROM ranked y WHERE y.lineage=x.lineage AND y.record=x.record AND y.rn>$1 AND y.cause<>'erased')
	ORDER BY x.lineage, x.record, x.revision),
since AS (SELECT o.lineage, o.collection, o.record, o.revision, (SELECT max(h.revision) FROM history h
	WHERE h.lineage=o.lineage AND h.record=o.record AND h.revision<=o.revision
	AND (h.op='create' OR h.cause='erased' OR h.meta->>'full'='true')) AS create_revision
	FROM oldest o WHERE o.op = 'update'),
anchored AS (UPDATE bolt_history h SET op = 'create', changes = (SELECT coalesce(jsonb_object_agg(f.k, f.v), '{}'::jsonb) FROM (
		SELECT DISTINCT ON (e.k) e.k, e.v FROM history p CROSS JOIN LATERAL jsonb_each(p.changes) e(k, v)
		WHERE p.lineage=s.lineage AND p.record=s.record AND p.revision BETWEEN s.create_revision AND s.revision
		ORDER BY e.k, p.revision DESC) f)
	FROM since s WHERE s.create_revision IS NOT NULL
	AND h.collection = s.collection AND h.record = s.record AND h.revision = s.revision RETURNING 1),
gone AS (DELETE FROM bolt_history h USING ranked x
	WHERE h.collection = x.collection AND h.record = x.record AND h.revision = x.revision
	AND x.rn > $1 AND x.cause <> 'erased' RETURNING 1)
SELECT CASE WHEN (SELECT valid FROM admitted) THEN (SELECT count(*)::int FROM gone) END AS n`,
			params: [keep, JSON.stringify(acks)]
		},
		{ tables: ['bolt_history'], mode: 'SHARE ROW EXCLUSIVE' }
	);
	for (const operation of acks) acknowledgements(db).delete(operation);
	return Number(res.rows[0]?.['n'] ?? 0);
});
