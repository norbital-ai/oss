import { Effect } from 'effect';
// Committed history is scoped and masked by current reader authority; pending proposals append no revisions.
import type { Json } from '../../decl/values.ts';
import type { Bindings, Reader, Sql } from '../contracts.ts';
import type { Pred, ReadIR } from '../../protocol/ir-types.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { catalogOf } from '../access/pred.ts';
import { readScope } from '../access/authority.ts';
import { collectionOf, exposedField, q } from '../../protocol/catalog.ts';
import { grantSql } from './sql.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const MASKED: Json = { $masked: true };
const isTrue = (p: Pred) => p.t === 'const' && p.value;
export const readHistory = Effect.fn('Bolt.readHistory')(function* (
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
	const cat = catalogOf(m),
		c = collectionOf(cat, read.collection),
		id = read.id;
	if (!UUID.test(id)) return read.full === true ? null : [];
	const at = read.at;
	const params: Json[] = [read.collection, id];
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
			text: `SELECT h.revision, to_char(h.at AT TIME ZONE 'UTC', ${ISO}) AS at, h.actor, h.op, h.cause, h.restored_from, h.changes,
			h.request::text AS request, ap.state AS request_state
		FROM bolt_history h LEFT JOIN bolt_approvals ap ON ap.id = h.request
		WHERE h.collection = $1 AND h.record = $2::uuid ${cut} ORDER BY h.revision`,
			params
		}
	];
	const auth = reader.as === 'caller' && !reader.authority.admin ? reader.authority : null;
	const self: Pred = { t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Lit', value: id } };
	const masks = Object.entries(auth?.collections[read.collection]?.masks ?? {});
	const scope = auth === null ? undefined : readScope(auth, read.collection, 'history');
	if (auth !== null) {
		// grant predicates, so compiled raw; an `{ actor }` operand in them resolves against the caller
		statements.push(
			{ text: `SELECT 1 FROM ${q(c.model.name)} WHERE id = $1::uuid`, params: [id] },
			grantSql(
				cat,
				read.collection,
				{ t: 'and', of: [scope ?? { t: 'const', value: false }, self] },
				auth,
				bindings
			),
			...masks.map(([, p]) =>
				grantSql(cat, read.collection, { t: 'and', of: [p, self] }, auth, bindings)
			)
		);
	}
	const res = yield* db.read(statements);
	let hidden = new Set<string>();
	if (auth !== null) {
		const exists = res[1]!.rows.length > 0;
		// a live row needs the history scope; a deleted one, an unconditional read grant (rule 17)
		const visible = exists
			? res[2]!.rows.length > 0
			: (auth.collections[read.collection]?.read ?? []).some((a) => isTrue(a.where));
		if (!visible) return read.full === true ? null : [];
		hidden = new Set(
			masks.filter((_, i) => !exists || res[3 + i]!.rows.length === 0).map(([f]) => f)
		);
	}
	const revisions = res[0]!.rows.map((row) => {
		const actor = typeof row['actor'] === 'string' ? row['actor'] : null;
		const colon = actor?.indexOf(':') ?? -1;
		const changed = Object.fromEntries(
			Object.entries(
				(row['changes'] ?? {}) as {
					[k: string]: Json;
				}
			)
				.filter(([f]) => reader.as === 'workspace' || exposedField(c, f))
				.map(([f, v]) => [f, hidden.has(f) ? MASKED : v])
		);
		return {
			revision: row['revision'] ?? null,
			at: row['at'] ?? null,
			cause: row['cause'] ?? null,
			restoredFrom: row['restored_from'] ?? null,
			/** The approval request this revision belongs to: its provisional change, a reviewer's edit, or its rollback. */
			approval:
				typeof row['request'] === 'string'
					? { request: row['request'], state: row['request_state'] ?? null }
					: null,
			changed,
			actor:
				actor === null || colon < 0
					? null
					: { kind: actor.slice(0, colon), id: actor.slice(colon + 1) }
		};
	});
	if (read.full !== true) return revisions;
	type Rec = {
		[k: string]: Json;
	};
	let record = null as Rec | null;
	for (const [i, r] of revisions.entries()) {
		const op = res[0]!.rows[i]!['op'],
			prev = record;
		record =
			op === 'create'
				? { ...r.changed, id, revision: r.revision }
				: op === 'delete' || prev === null
					? null
					: { ...prev, ...r.changed, revision: r.revision };
	}
	return record === null
		? null
		: Object.fromEntries(
				Object.entries(record).map(([field, value]) => [
					field,
					c.model.fields.get(field)?.pg === 'numeric' &&
					(typeof value === 'string' || typeof value === 'number')
						? { $dec: String(value) }
						: value
				])
			);
});
/**
 * Keeps the newest committed revisions and all erased audit markers. The oldest kept revision of a pruned record becomes
 * its anchor: the full row folded from its create, recorded as that create, so every kept revision still rebuilds (and
 * so stays restorable) — never an open restore point.
 */
export const pruneHistory = Effect.fn('Bolt.pruneHistory')(function* (
	db: TenantDb,
	keep: number = 256
) {
	const res = yield* db.write({
		text: `WITH ranked AS (
	SELECT collection, record, revision, op, cause, row_number() OVER (PARTITION BY collection, record ORDER BY revision DESC) AS rn
	FROM bolt_history),
oldest AS (SELECT DISTINCT ON (x.collection, x.record) x.collection, x.record, x.revision, x.op FROM ranked x
	WHERE x.rn <= $1 AND x.cause <> 'erased'
	AND EXISTS (SELECT 1 FROM ranked y WHERE y.collection = x.collection AND y.record = x.record AND y.rn > $1 AND y.cause <> 'erased')
	ORDER BY x.collection, x.record, x.revision),
since AS (SELECT o.collection, o.record, o.revision, (SELECT max(h.revision) FROM bolt_history h
	WHERE h.collection = o.collection AND h.record = o.record AND h.op = 'create' AND h.revision <= o.revision) AS create_revision
	FROM oldest o WHERE o.op = 'update'),
anchored AS (UPDATE bolt_history h SET op = 'create', changes = (SELECT coalesce(jsonb_object_agg(f.k, f.v), '{}'::jsonb) FROM (
		SELECT DISTINCT ON (e.k) e.k, e.v FROM bolt_history p CROSS JOIN LATERAL jsonb_each(p.changes) e(k, v)
		WHERE p.collection = s.collection AND p.record = s.record AND p.revision BETWEEN s.create_revision AND s.revision
		ORDER BY e.k, p.revision DESC) f)
	FROM since s WHERE s.create_revision IS NOT NULL
	AND h.collection = s.collection AND h.record = s.record AND h.revision = s.revision RETURNING 1),
gone AS (DELETE FROM bolt_history h USING ranked x
	WHERE h.collection = x.collection AND h.record = x.record AND h.revision = x.revision
	AND x.rn > $1 AND x.cause <> 'erased' RETURNING 1)
SELECT count(*)::int AS n FROM gone`,
		params: [keep]
	});
	return Number(res.rows[0]?.['n'] ?? 0);
});
