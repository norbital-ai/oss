// History (rule 17): `history(collection, id, { at? })` over `bolt_history`, and the platform prune. A reader sees the
// revisions of a row its `history` grant scopes (a deleted row's, with a `read: true` grant), each `changed` limited to
// the collection's read exposure and masked by the reader's current grant. One pipelined round trip. `hold` revisions
// (an approval's pre-image, A.2 L-BOLT-185) are skipped. `get(c, id, { revision })` folds the revisions into the full
// record as of that revision (L-BOLT-181); a row whose create was pruned folds to `null`.
import type { Json } from '../../decl/values.ts';
import type { Bindings, EngineManifest, Pred, ReadIR, Reader, Sql, TenantDb } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { readScope } from '../access/authority.ts';
import { collectionOf, exposedField, q } from '../../protocol/catalog.ts';
import { grantSql } from './sql.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const MASKED: Json = { $masked: true };
const isTrue = (p: Pred) => p.t === 'const' && p.value;

export async function readHistory(db: TenantDb, m: EngineManifest, read: Extract<ReadIR, { kind: 'history' }>, reader: Reader, bindings: Bindings): Promise<Json> {
	const cat = catalogOf(m), c = collectionOf(cat, read.collection), id = read.id;
	if (!UUID.test(id)) return read.full === true ? null : [];
	const at = read.at;
	const params: Json[] = [read.collection, id];
	const cut = at === undefined ? '' : 'instant' in at ? (params.push(at.instant), 'AND at <= $3::timestamptz')
		: 'revision' in at ? (params.push(at.revision), 'AND revision <= $3::int')
		: (params.push(at.before), `AND revision < coalesce((SELECT min(revision) FROM bolt_history WHERE collection = $1 AND record = $2::uuid AND approval_id = $3::uuid AND cause <> 'hold'), 2147483647)`);
	const statements: Sql[] = [{ text: `SELECT revision, to_char(at AT TIME ZONE 'UTC', ${ISO}) AS at, actor, op, cause, approval_id::text AS approval_id, changes
		FROM bolt_history WHERE collection = $1 AND record = $2::uuid AND cause <> 'hold' ${cut} ORDER BY revision`, params }];
	const auth = reader.as === 'caller' && !reader.authority.admin ? reader.authority : null;
	const self: Pred = { t: 'cmp', field: 'id', op: 'eq', arg: { lit: id } };
	const masks = Object.entries(auth?.collections[read.collection]?.masks ?? {});
	const scope = auth === null ? undefined : readScope(auth, read.collection, 'history');
	if (auth !== null) {
		// grant predicates, so compiled raw; an `{ actor }` operand in them resolves against the caller
		statements.push({ text: `SELECT 1 FROM ${q(c.model.name)} WHERE id = $1::uuid`, params: [id] },
			grantSql(cat, read.collection, { t: 'and', of: [scope ?? { t: 'const', value: false }, self] }, auth, bindings),
			...masks.map(([, p]) => grantSql(cat, read.collection, { t: 'and', of: [p, self] }, auth, bindings)));
	}
	const res = await db.read(statements);
	let hidden = new Set<string>();
	if (auth !== null) {
		const exists = res[1]!.rows.length > 0;
		// a live row needs the history scope; a deleted one, an unconditional read grant (rule 17)
		const visible = exists ? res[2]!.rows.length > 0 : (auth.collections[read.collection]?.read ?? []).some((a) => isTrue(a.where));
		if (!visible) return read.full === true ? null : [];
		hidden = new Set(masks.filter((_, i) => !exists || res[3 + i]!.rows.length === 0).map(([f]) => f));
	}
	const revisions = res[0]!.rows.map((row) => {
		const actor = typeof row['actor'] === 'string' ? row['actor'] : null;
		const colon = actor?.indexOf(':') ?? -1;
		const changed = Object.fromEntries(Object.entries((row['changes'] ?? {}) as { [k: string]: Json }) // a held create's hold revision has no pre-image
			.filter(([f]) => reader.as === 'workspace' || exposedField(c, f))
			.map(([f, v]) => [f, hidden.has(f) ? MASKED : v]));
		return { revision: row['revision'] ?? null, at: row['at'] ?? null, cause: row['cause'] ?? null, approval_id: row['approval_id'] ?? null, changed,
			actor: actor === null || colon < 0 ? null : { kind: actor.slice(0, colon), id: actor.slice(colon + 1) } };
	});
	if (read.full !== true) return revisions;
	type Rec = { [k: string]: Json };
	let record = null as Rec | null;
	for (const [i, r] of revisions.entries()) {
		const op = res[0]!.rows[i]!['op'], prev = record;
		record = op === 'create' ? { ...r.changed, id, revision: r.revision } : op === 'delete' || prev === null ? null : { ...prev, ...r.changed, revision: r.revision };
	}
	return record;
}

/**
 * The platform prune (rules 17, 56): keeps the newest `keep` revisions per row, every `erased` revision, and, for a row an
 * open approval holds (its newest revision carries the request), every revision from the request's restore point on.
 */
export async function pruneHistory(db: TenantDb, keep = 256): Promise<number> {
	const res = await db.write({ text: `WITH ranked AS (
	SELECT collection, record, revision, cause, approval_id, row_number() OVER w AS rn, first_value(approval_id) OVER w AS held
	FROM bolt_history WINDOW w AS (PARTITION BY collection, record ORDER BY revision DESC)),
anchor AS (SELECT collection, record, min(revision) - 1 AS restore FROM ranked WHERE held IS NOT NULL AND approval_id = held GROUP BY collection, record),
gone AS (DELETE FROM bolt_history h USING ranked x LEFT JOIN anchor a USING (collection, record)
	WHERE h.collection = x.collection AND h.record = x.record AND h.revision = x.revision
	AND x.rn > $1 AND x.cause <> 'erased' AND (a.restore IS NULL OR x.revision < a.restore) RETURNING 1)
SELECT count(*)::int AS n FROM gone`, params: [keep] });
	return Number(res.rows[0]!['n']);
}
