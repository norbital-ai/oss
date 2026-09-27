// The one write statement (rule 20): a `WITH` chain gated on the idempotency record, with every row change as a piece
// (one write per row, rule 21), cascades and `setNull` expanded in SQL, `seq` drawn from counter rows, roll-ups folded
// from the child pieces' `RETURNING old/new`, history, queued runs, notices and outbox rows, and the outcome.
import type { Json } from '../../decl/values.ts';
import type { EngineActor, EngineManifest, NoticeRow, OutboxRow, QueuedRun, RowData, Sql } from '../contracts.ts';
import { toPred } from '../access/pred.ts';
import { q, type Catalog } from '../../protocol/catalog.ts';
import { eventsPiece, type SysEvent } from '../guest/telemetry.ts';
import { queueTriggered, REPLACE_QUEUED } from '../runs/queue.ts'; // hook:automations
import { outboundPiece } from '../channels/outbound.ts'; // hook:envoys
import { answer, cells, Chain, fingerprintAsserts, GATED, gate, noticeCaptures, noticeInsert, ownPredSql, rate, type Fingerprint } from './sql.ts';

/** One row change as the statement writes it: upserts are already resolved, updates carry the stored revision. */
export type Write = { collection: string; id: string } & (
	| { op: 'create'; values: RowData }
	| { op: 'update'; set: RowData; revision: number }
	| { op: 'delete'; revision: number });
export type RateCharge = { rule: string; bucket: string; limit: number; windowStart: string };
/** Rule 41: child writes on an owned relationship take `FOR SHARE` on their parents, re-testing the admitting states. */
export type OwnedLock = { child: string; parent: string; field: string; ids: readonly string[]; states: readonly string[] };
export type Commit = {
	key: string; digest: string; issuedAt: string; now: string; today: string; actor: EngineActor;
	writes: readonly Write[]; owned: readonly OwnedLock[]; rate: readonly RateCharge[];
	runs: readonly (QueuedRun & { id: string; actor?: string; starter?: Json })[]; notices: readonly (NoticeRow & { id: string })[]; outbox: readonly (OutboxRow & { id: string })[];
	output: Json;
	/** Rule 45 (P3): a routed act stamps every created or updated row and adds the approval's own pieces. */
	approval?: { requestId: string; pieces?: (c: Chain) => void };
	/** hook:integrations — pieces after `allp` (the integration's sync shadow). */
	pieces?: (c: Chain) => void;
	/** Rule 26: the transform's reads, re-digested under the table lock and asserted before the statement commits. */
	fingerprints?: readonly Fingerprint[];
	/** §5.12: the invocation's buffered `sys_event` rows, a piece of this statement. */
	events?: readonly SysEvent[];
	/**
	 * Rule 38e: the direct pieces are `erased` revisions. Remove drops every revision of every deleted row; anonymise
	 * drops `purge` fields from the targets' earlier revisions (a revision left empty goes). Both drop notices linking
	 * a deleted row.
	 */
	erase?: { mode: 'remove' } | { mode: 'anonymise'; collection: string; ids: readonly string[]; purge: readonly string[] };
};
type Piece = { name: string; table: string };

/** `created_by`/`updated_by`: a member's id, or an envoy turn's linked sender (hook:envoys, P32); other actors are recorded in history only. */
export const actorId = (a: EngineActor): string | null => a.kind === 'member' ? a.id : a.kind === 'envoy' ? a.member : null;
/** History's actor (rule 17): `<kind>:<id>`. */
export const actorRef = (a: EngineActor): string =>
	`${a.kind}:${a.kind === 'member' ? a.id : a.kind === 'system' ? a.run : a.kind === 'apiKey' ? a.key : a.kind === 'visitor' ? a.visitor : a.sender}`;

const RETURNING = (table: string, op: string, cause: string) => `RETURNING ${`'${table}'`}::text AS c, coalesce(new.id, old.id)::text AS id,
	coalesce(new.revision, old.revision + 1)::int AS revision, '${op}'::text AS op, '${cause}'::text AS cause,
	CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o, CASE WHEN new.id IS NULL THEN NULL ELSE to_jsonb(new) END AS n`;
const union = (pieces: readonly Piece[]) => pieces.map((p) => `SELECT c, id, revision, op, cause, o, n FROM ${p.name}`).join(' UNION ALL ');

/** Roll-up fields of `model`: `{ kind: 'sum', of: 'lines.amount' }` / `{ kind: 'count', of: 'lines' }` with their `where`. */
export function rollups(m: EngineManifest, cat: Catalog, model: string) {
	return Object.entries(m.models[model]?.fields ?? {}).flatMap(([field, k]) => {
		if (k.kind !== 'sum' && k.kind !== 'count') return [];
		const [relName, childField] = k.of.split('.') as [string, string | undefined];
		const rel = cat.models.get(model)!.many.get(relName)!;
		return [{ field, kind: k.kind, child: rel.child, fk: rel.column, childField, where: k.where === undefined ? undefined : toPred(m, rel.child, k.where) }];
	});
}

/** A `seq` pattern's text around its counter, the period tokens resolved (`'PO-{yyyy}-{0000}'` → `PO-2026-`, 4, ``). */
export function seqParts(pattern: string | undefined, date: { yyyy: string; mm: string }): { pre: string; width: number; post: string } {
	const dated = (pattern ?? '{0}').replaceAll('{yyyy}', date.yyyy).replaceAll('{yy}', date.yyyy.slice(2)).replaceAll('{mm}', date.mm);
	const counter = /\{(0+)\}/.exec(dated);
	return counter === null ? { pre: dated, width: 1, post: '' }
		: { pre: dated.slice(0, counter.index), width: counter[1]!.length, post: dated.slice(counter.index + counter[0].length) };
}
/** A counter's scope in `bolt_seq`: the pattern period and the `per` values. */
export const seqScope = (pre: string, post: string, per: readonly Json[]): string => JSON.stringify([pre, post, ...per]);
/** `seq` meta per created row (host side): the counter key per pattern period and `per` scope, and the row's place in it. */
function seqMeta(m: EngineManifest, writes: readonly Write[], today: string) {
	const counts = new Map<string, number>();
	const plan: { w: Write & { op: 'create' }; field: string; key: string; index: number; pre: string; width: number; post: string; text: boolean }[] = [];
	for (const w of writes) {
		if (w.op !== 'create') continue;
		for (const [field, k] of Object.entries(m.models[w.collection]?.fields ?? {})) {
			if (k.kind !== 'seq') continue;
			const { pre, width, post } = seqParts(k.pattern, { yyyy: today.slice(0, 4), mm: today.slice(5, 7) });
			const scope = seqScope(pre, post, (k.per ?? []).map((p) => w.values[p] ?? null));
			const key = JSON.stringify([w.collection, field, scope]);
			const index = counts.get(key) ?? 0;
			counts.set(key, index + 1);
			plan.push({ w, field, key, index, pre, width, post, text: k.pattern !== undefined });
		}
	}
	return { counts, plan };
}

export function compileCommit(m: EngineManifest, cat: Catalog, x: Commit): Sql {
	const c = new Chain();
	gate(c, x.key, x.digest, x.issuedAt);
	rate(c, x.rate);
	fingerprintAsserts(c, x.fingerprints ?? []);
	const direct = x.erase === undefined ? 'direct' : 'erased';
	const by = actorId(x.actor);
	const system = (op: 'create' | 'update') => ({ updated_at: x.now, updated_by: by, ...(x.approval ? { approval_id: x.approval.requestId } : {}),
		...(op === 'create' ? { revision: 1, created_at: x.now, created_by: by } : {}) });

	// seq counters: one piece for every key the act draws from
	const seq = seqMeta(m, x.writes, x.today);
	const meta = new Map<Write, Record<string, Json>>();
	for (const s of seq.plan) {
		const back = seq.counts.get(s.key)! - 1 - s.index;
		meta.set(s.w, { ...meta.get(s.w), [s.field]: [JSON.parse(s.key) as Json, back, s.pre, s.width, s.post, s.text] });
	}
	// `bolt_seq (model, field, scope, value)` is the schema area's; `key` is the three as a JSON array
	if (seq.counts.size > 0) c.cte('seq', `INSERT INTO bolt_seq (model, field, scope, value)
	SELECT v.k->>0, v.k->>1, v.k->>2, v.c FROM jsonb_to_recordset(${c.p([...seq.counts].map(([key, n]) => ({ k: JSON.parse(key) as Json, c: n })))}::jsonb) AS v(k jsonb, c int)
	WHERE ${GATED} ON CONFLICT (model, field, scope) DO UPDATE SET value = bolt_seq.value + excluded.value
	RETURNING jsonb_build_array(model, field, scope) AS key, value AS n`);

	// rule 41: an owned child's direct write holds its parent in an admitting state. The child piece reads the assert, so
	// the parent's `FOR SHARE` is taken before any piece of this statement changes that parent (a row the statement
	// already changed would be skipped by `FOR SHARE`, not re-tested)
	const held = new Map<string, string>();
	for (const o of x.owned) {
		const a = c.assert(`(SELECT count(*) FROM (SELECT 1 FROM ${q(o.parent)} WHERE id::text IN (SELECT jsonb_array_elements_text(${c.p(o.ids)}::jsonb))
	AND ${q(o.field)}::text IN (SELECT jsonb_array_elements_text(${c.p(o.states)}::jsonb)) FOR SHARE) s) = ${o.ids.length}`, 'locked');
		held.set(o.child, `${held.has(o.child) ? `${held.get(o.child)} AND ` : ''}EXISTS (SELECT 1 FROM ${a})`);
	}
	const guard = (table: string) => held.has(table) ? `${GATED} AND ${held.get(table)}` : GATED;
	const pieces: Piece[] = [];
	const on = (table: string) => pieces.filter((p) => p.table === table);
	let n = 0;
	const add = (table: string, sql: string, count?: { rows: number; ids: readonly string[] }): string => {
		const name = c.cte(`p${n++}`, sql);
		pieces.push({ name, table });
		if (count !== undefined) c.assert(`(SELECT count(*) FROM ${name}) = ${count.rows}`, 'conflict', JSON.stringify({ collection: table, ids: count.ids }));
		return name;
	};
	const byTable = Map.groupBy(x.writes, (w) => w.collection);

	// deletes first, then cascades and `setNull` expanded in SQL (§5.2: FKs are NO ACTION, the engine cascades, depth ≤ 8)
	const deleted = new Map<string, string[]>();
	for (const [table, ws] of byTable) {
		const rows = ws.filter((w) => w.op === 'delete').map((w) => ({ id: w.id, revision: w.revision }));
		if (rows.length === 0) continue;
		const name = add(table, `DELETE FROM ${q(table)} t USING jsonb_populate_recordset(null::${q(table)}, ${c.p(rows)}::jsonb) r
	WHERE t.id = r.id AND t.revision = r.revision AND ${guard(table)} ${RETURNING(table, 'delete', direct)}`, { rows: rows.length, ids: rows.map((r) => r.id) });
		deleted.set(table, [name]);
	}
	for (let depth = 0, frontier = [...deleted.keys()]; depth < 8 && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const parent of frontier) for (const rel of cat.models.get(parent)?.many.values() ?? []) {
			const spec = m.relationships[`${rel.child}.${rel.column}`];
			const rule = spec?.owned ? 'cascade' : spec?.onDelete ?? 'restrict';
			if (rule === 'restrict') continue;
			const gone = `(${deleted.get(parent)!.map((d) => `SELECT id FROM ${d}`).join(' UNION ALL ')})`;
			const others = on(rel.child).map((p) => ` AND t.id::text NOT IN (SELECT id FROM ${p.name})`).join('');
			if (rule === 'cascade') {
				const name = add(rel.child, `DELETE FROM ${q(rel.child)} t WHERE t.${q(rel.column)}::text IN ${gone}${others} AND ${GATED} ${RETURNING(rel.child, 'delete', 'cascade')}`);
				deleted.set(rel.child, [...deleted.get(rel.child) ?? [], name]);
				next.push(rel.child);
			} else add(rel.child, `UPDATE ${q(rel.child)} t SET ${q(rel.column)} = NULL, revision = t.revision + 1, updated_at = ${c.p(x.now)}::timestamptz
	WHERE t.${q(rel.column)}::text IN ${gone}${others} AND ${GATED} ${RETURNING(rel.child, 'update', 'cascade')}`);
		}
		frontier = [...new Set(next)];
	}

	// creates and updates, children before the parents whose roll-ups they feed
	const order: string[] = [];
	const visit = (t: string, seen: Set<string>) => {
		if (order.includes(t) || seen.has(t)) return;
		seen.add(t);
		for (const r of rollups(m, cat, t)) visit(r.child, seen);
		order.push(t);
	};
	// every model, so a parent the act does not write still takes its derived roll-up write
	for (const t of new Set([...byTable.keys(), ...pieces.map((p) => p.table), ...Object.keys(m.models)])) visit(t, new Set());
	for (const table of order) {
		// roll-up deltas from every piece on the child so far, new minus old, each side under the roll-up's `where`
		const folds = rollups(m, cat, table).flatMap((r) => {
			const src = on(r.child);
			if (src.length === 0) return [];
			const side = (col: 'o' | 'n', sign: string) => `SELECT (s.row).${q(r.fk)} AS pid, ${sign}${r.kind === 'count' ? '1' : `coalesce((s.row).${q(r.childField!)}, 0)`} AS d
		FROM (SELECT jsonb_populate_record(null::${q(r.child)}, x.${col}) AS row FROM (${union(src)}) x WHERE x.${col} IS NOT NULL) s
		WHERE ${r.where === undefined ? 'true' : ownPredSql(r.where, 's.row', c)}`;
			const rd = c.cte(`rd${n++}`, `${side('o', '-')} UNION ALL ${side('n', '')}`);
			return [{ field: r.field, rd }];
		});
		const fold = (f: { field: string; rd: string }, base: string, id: string) => `${base} + coalesce((SELECT sum(d) FROM ${f.rd} WHERE pid = ${id}), 0)`;
		const ws = byTable.get(table) ?? [];
		const fields = cat.models.get(table)?.fields ?? new Map();

		for (const shape of Map.groupBy(ws.filter((w) => w.op === 'create'), (w) => Object.keys(w.values).sort().join(',')).values()) {
			const rows = shape.map((w) => ({ ...Object.fromEntries(Object.entries(w.values).flatMap(([k, v]) => cells(k, v, fields.get(k)))), ...system('create'), id: w.id, $seq: meta.get(w) ?? {} }));
			const cols = [...new Set(['id', ...Object.keys(rows[0]!).filter((k) => k !== '$seq' && k !== 'id')])];
			const seqCols = Object.keys(rows[0]!.$seq);
			const seqExpr = (f: string) => {
				const at = (i: number) => `(e.j->'$seq'->'${f}'->>${i})`;
				const num = `((SELECT s.n FROM seq s WHERE s.key = (e.j->'$seq'->'${f}'->0)) - ${at(1)}::int)`;
				return `CASE WHEN ${at(5)}::boolean THEN ${at(2)} || CASE WHEN length(${num}::text) >= ${at(3)}::int THEN ${num}::text ELSE lpad(${num}::text, ${at(3)}::int, '0') END || ${at(4)} ELSE ${num}::text END`;
			};
			const all = [...cols, ...seqCols, ...folds.map((f) => f.field)];
			add(table, `INSERT INTO ${q(table)} (${all.map(q).join(', ')})
	SELECT ${[...cols.map((k) => `r.${q(k)}`), ...seqCols.map((f) => `(${seqExpr(f)})::${cat.models.get(table)!.fields.get(f)!.pg}`), ...folds.map((f) => fold(f, '0', 'r.id'))].join(', ')}
	FROM jsonb_array_elements(${c.p(rows)}::jsonb) e(j), jsonb_populate_record(null::${q(table)}, e.j) r WHERE ${guard(table)} ${RETURNING(table, 'create', direct)}`);
		}
		for (const shape of Map.groupBy(ws.filter((w) => w.op === 'update'), (w) => Object.keys(w.set).sort().join(',')).values()) {
			const rows = shape.map((w) => ({ ...Object.fromEntries(Object.entries(w.set).flatMap(([k, v]) => cells(k, v, fields.get(k)))), ...system('update'), id: w.id, revision: w.revision }));
			const sets = Object.keys(rows[0]!).filter((k) => k !== 'id' && k !== 'revision').map((k) => `${q(k)} = r.${q(k)}`);
			add(table, `UPDATE ${q(table)} t SET ${[...sets, ...folds.map((f) => `${q(f.field)} = ${fold(f, `t.${q(f.field)}`, 't.id')}`), 'revision = t.revision + 1'].join(', ')}
	FROM jsonb_populate_recordset(null::${q(table)}, ${c.p(rows)}::jsonb) r WHERE t.id = r.id AND t.revision = r.revision AND ${guard(table)} ${RETURNING(table, 'update', direct)}`,
			{ rows: rows.length, ids: rows.map((r) => r.id) });
		}
		// rows the act did not write whose roll-ups moved: one derived write each (rule 43), never twice in one statement
		if (folds.length > 0) {
			const mine = on(table).map((p) => ` AND t.id::text NOT IN (SELECT id FROM ${p.name})`).join('');
			add(table, `UPDATE ${q(table)} t SET ${[...folds.map((f) => `${q(f.field)} = ${fold(f, `t.${q(f.field)}`, 't.id')}`), 'revision = t.revision + 1',
				`updated_at = ${c.p(x.now)}::timestamptz`].join(', ')}
	WHERE t.id IN (${folds.map((f) => `SELECT pid FROM ${f.rd} GROUP BY pid HAVING sum(d) <> 0`).join(' UNION ')})${mine} AND ${GATED} ${RETURNING(table, 'update', 'derived')}`);
		}
	}


	const all = pieces.length === 0 ? 'SELECT NULL::text c, NULL::text id, NULL::int revision, NULL::text op, NULL::text cause, NULL::jsonb o, NULL::jsonb n WHERE false' : union(pieces);
	c.cte('allp', all);
	// history keeps authored changes only: never the search document or the platform embedding (rule 17)
	if (pieces.length > 0) c.cte('hist', `INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, approval_id, changes)
	SELECT x.c, x.id::uuid, x.revision, ${c.p(x.now)}::timestamptz, ${c.p(actorRef(x.actor))}, x.op, x.cause, (coalesce(x.n, x.o) ->> 'approval_id')::uuid,
		CASE x.op WHEN 'create' THEN x.n - ${UNHISTORIED} WHEN 'delete' THEN '{}'::jsonb ELSE (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(x.n) AS e(k, v)
			WHERE k NOT IN ('revision', 'updated_at', 'updated_by') AND k <> ALL (${UNHISTORIED}) AND x.o -> k IS DISTINCT FROM v) END
	FROM allp x${x.erase?.mode === 'remove' ? ` WHERE x.op <> 'delete' OR x.cause = 'erased'` : ''}`);
	if (x.erase !== undefined && pieces.length > 0) erasePieces(c, x.erase);
	if (x.erase === undefined) queueTriggered(m, c, x.now, actorRef(x.actor)); // hook:automations — event runs, never on erase (rule 50)
	if (x.erase === undefined) outboundPiece(m, c, x.now); // hook:envoys — record-driven outbound in the causing statement (rule 61)
	if (x.runs.length > 0) c.cte('runs', `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth, actor, starter)
	SELECT v.id, v.automation, v.input, v."dueAt", v.key, v.cause, v.depth, v.actor, v.starter FROM jsonb_to_recordset(${c.p(x.runs)}::jsonb)
		AS v(id text, automation text, input jsonb, "dueAt" timestamptz, key text, cause text, depth int, actor text, starter jsonb) WHERE ${GATED} ${REPLACE_QUEUED}`); // hook:automations (rule 51: the same key replaces)
	if (x.notices.length > 0) noticeInsert(c, 'notices', x.notices as unknown as Json, x.now, m.teams);
	if (x.outbox.length > 0) c.cte('outbox', `INSERT INTO bolt_outbox (id, channel, message, record, at)
	SELECT v.id, v.channel, v.message, v.record, ${c.p(x.now)}::timestamptz FROM jsonb_to_recordset(${c.p(x.outbox)}::jsonb)
		AS v(id text, channel text, message jsonb, record jsonb) WHERE ${GATED}`);
	x.approval?.pieces?.(c);
	events(c, x.events);
	x.pieces?.(c); // hook:integrations

	// the act's own record first (a create's new row), then the rest by collection and id: `records[0]` is what was written
	const root = x.writes[0];
	const first = root === undefined ? '' : `(c = ${c.p(root.collection)} AND id = ${c.p(root.id)}) DESC, `;
	const records = `(SELECT coalesce(jsonb_agg(jsonb_build_object('collection', c, 'id', id, 'revision', revision) ORDER BY ${first}c, id), '[]'::jsonb) FROM allp WHERE cause IN ('direct', 'erased'))`;
	const outcome = x.approval === undefined
		? `jsonb_build_object('kind', 'committed', 'output', ${c.p(JSON.stringify(x.output))}::jsonb, 'records', ${records})`
		: `jsonb_build_object('kind', 'pendingApproval', 'requestId', ${c.p(x.approval.requestId)}::text, 'records', ${records})`;
	const result = answer(c, x.key, x.digest, outcome);
	const tables = [...new Set(pieces.map((p) => p.table))];
	return c.sql(`${result}, (SELECT coalesce(jsonb_agg(jsonb_build_object('collection', c, 'id', id, 'op', op, 'revision', revision,
		'old', ${numericText(cat, tables, 'o')}, 'new', ${numericText(cat, tables, 'n')}, 'cause', cause)), '[]'::jsonb) FROM allp) || ${noticeCaptures(c)} AS captured`);
}

/**
 * Rule 65: the captured image's stored `numeric` columns (decimal, money, sum) as text, so a live delta keeps their scale
 * (`1.20`; a parsed JSON number is 1.2) and patches them without a read. History and the triggers compare old with new,
 * which stay alike; `holds3` and `eval` compare a numeric text as a number.
 */
export function numericText(cat: Catalog, tables: readonly string[], x: string): string {
	const arms = tables.flatMap((t) => {
		const cols = [...cat.models.get(t)?.fields.values() ?? []].filter((f) => f.pg === 'numeric' && f.computed !== true).map((f) => `'${f.column}', ${x}->>'${f.column}'`);
		// jsonb_build_object takes at most 100 arguments
		const objects = Array.from({ length: Math.ceil(cols.length / 50) }, (_, i) => `jsonb_build_object(${cols.slice(i * 50, i * 50 + 50).join(', ')})`);
		return objects.length === 0 ? [] : [`WHEN c = '${t}' THEN ${x} || ${objects.join(' || ')}`];
	});
	return arms.length === 0 ? x : `CASE WHEN ${x} IS NULL THEN NULL ${arms.join(' ')} ELSE ${x} END`;
}

/**
 * The outcome record (rule 20): a refusal or conflict decided after guest code or inside Postgres, recorded with the
 * rate increment so a replay answers it without re-running guest code, and so refused attempts count.
 */
export function compileOutcomeRecord(x: Pick<Commit, 'key' | 'digest' | 'issuedAt' | 'rate' | 'events'>, outcome: Json): Sql {
	const c = new Chain();
	gate(c, x.key, x.digest, x.issuedAt);
	rate(c, x.rate);
	events(c, x.events);
	return c.sql(`${answer(c, x.key, x.digest, `${c.p(JSON.stringify(outcome))}::jsonb`)}, '[]'::jsonb AS captured`);
}

/** Columns history never keeps: the generated search document and the platform embedding. */
const UNHISTORIED = `ARRAY['bolt_search', 'bolt_embedding']`;
/** §5.12: the buffered events as one gated piece (written only when the statement writes at all). */
function events(c: Chain, rows: readonly SysEvent[] | undefined): void {
	if (rows === undefined || rows.length === 0) return;
	const p = c.p(rows as unknown as Json);
	c.cte('events', `${eventsPiece(Number(p.slice(1)))} WHERE ${GATED}`);
}
/** Rule 38e(a–c): the history purge and the notices of removed rows. The `erased` revision is this statement's own
 * insert, which no other piece sees, so it survives both purges. */
function erasePieces(c: Chain, e: NonNullable<Commit['erase']>): void {
	c.cte('notices_gone', `DELETE FROM sys_notification n USING allp x WHERE x.op = 'delete' AND n.link ->> 'collection' = x.c AND n.link ->> 'id' = x.id AND ${GATED}`);
	if (e.mode === 'remove') {
		c.cte('purge', `DELETE FROM bolt_history h USING allp x WHERE x.op = 'delete' AND h.collection = x.c AND h.record::text = x.id AND ${GATED}`);
		return;
	}
	const fields = `ARRAY(SELECT jsonb_array_elements_text(${c.p(e.purge)}::jsonb))`;
	const at = `h.collection = ${c.p(e.collection)} AND h.record::text IN (SELECT jsonb_array_elements_text(${c.p(e.ids)}::jsonb)) AND h.changes ?| ${fields}
		AND h.cause <> 'erased'`;
	c.cte('purge', `UPDATE bolt_history h SET changes = h.changes - ${fields} WHERE ${at} AND h.changes - ${fields} <> '{}'::jsonb AND ${GATED}`);
	c.cte('purge_empty', `DELETE FROM bolt_history h WHERE ${at} AND h.changes - ${fields} = '{}'::jsonb AND ${GATED}`);
}
