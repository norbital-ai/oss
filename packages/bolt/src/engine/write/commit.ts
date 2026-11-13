// One write statement per act: guarded direct writes and the referential actions they imply, roll-ups, row history,
// approvals, queued runs, notices, the sync outbox and the audit receipt, every row image taken from the pieces' RETURNING.
import type { Json } from '../../decl/values.ts';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import type { DbBatch, TenantDbShape } from '../db/tenant-db.ts';
import { Captured, captureRows } from '../db/captured.ts';
import { storedCaptures, storedImageSql } from '../db/stored.ts';
import { readGuardBaseline } from '../approvals/read-guards.ts';
import { Effect, Schema } from 'effect';
import type { NoticeInsert } from '../notifications/notify.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import type { EngineActor, Lock, QueuedRun, RowData, Sql } from '../contracts.ts';
import { relations, type EngineManifest } from '../manifest.ts';
import { Live, Wake, Links } from '../services.ts';
import { toOwnSql } from '../access/pred.ts';
import type { Where } from '@norbital-ai/store/kind';
import { q, cells, null_row_sql, own_pred_sql, type Catalog, type Pred } from '@norbital-ai/store';
import { enqueue, next_due, queue_effects, type Writer } from '../runs/queue.ts'; // hook:automations
import { syncOutboxPiece } from '../sync/write.ts'; // hook:syncs (H3)
import { purgeProposals } from '../approvals/erase.ts';
import {
	answer,
	Chain,
	fingerprintAsserts,
	GATED,
	gate,
	noticeInsert,
	rate,
	type Fingerprint,
	type ReadGuards
} from './sql.ts';
import { lockPieces } from '../approvals/lock.ts';
import { AuditMutation, auditReceipt } from '../audit-context.ts';
import { literal } from '@norbital-ai/store';
import { actor_id, actor_ref } from '../access/actor.ts';

/** One row change as the statement writes it: upserts are already resolved, updates carry the stored revision. */
export type Write = { model: string; id: string; erased?: boolean } &
	/** `revision`: a deleted row re-created by an approval rollback at its next revision; its values are stored columns, no `seq` is drawn. */
	(
		| { op: 'create'; values: RowData; revision?: number }
		| { op: 'update'; set: RowData; revision: number }
		| { op: 'delete'; revision: number }
	);
export type RateCharge = { rule: string; bucket: string; limit: number; windowStart: string };
/** Rule 41: child writes on an owned relationship take `FOR SHARE` on their parents, re-testing the admitting states. */
export type OwnedLock = {
	child: string;
	parent: string;
	where: Pred;
	ids: readonly string[];
};
export type Commit = {
	key: string;
	digest: string;
	issuedAt: string;
	now: string;
	today: string;
	actor: EngineActor;
	/** Who wrote: the model effects this statement queues run as them (`writerOf`). */
	writer: Writer;
	writes: readonly Write[];
	owned: readonly OwnedLock[];
	rate: readonly RateCharge[];
	runs: readonly (QueuedRun & { id: string; actor?: string; starter?: Json })[];
	notices: readonly NoticeInsert[];
	output: Json;
	/** An act that writes no row: the updated records that already held their values. */
	unchanged?: readonly { model: string; id: string }[];
	/**
	 * A routed write commits at once (provisional) and opens a request: its pieces follow the domain pieces and read
	 * `allp` for the checkpoint. `route` is the flow snapshot the approval callback returned (one per statement). When an
	 * open request already holds a touched row (`held`, the lock's CTE) the write joins it: no request opens and the
	 * outcome commits.
	 */
	approval?: {
		request_id: string;
		route: Extract<ApprovalSnapshot, { kind: 'steps' }>;
		pieces: (c: Chain, held: string | null) => void;
	};
	/** A requester's save on their own ChangesRequested request (`ApprovalHook.resubmit`): pieces after `allp` and the lock. */
	resubmit?: { request: string; pending: boolean; pieces: (c: Chain, held: string | null) => void };
	/** An approval decision's own statement: authorized in `before`, exempt from the lock, its history linked to `request`. */
	before?: (c: Chain) => void;
	approvalDecision?: { request: string; stands: boolean };
	/** An engine sync rollback owns peer recovery explicitly, outside the ordinary outbox hook. */
	rollback?: true;
	/** hook:syncs — pieces after `allp` (a sync read page's cursor, id map and version stamps). */
	pieces?: (c: Chain) => void;
	/** Rule 26: the write callbacks' reads, re-digested under the table lock and asserted before the statement commits. */
	fingerprints?: readonly Fingerprint[];
	/** Native prior automation query intent, fixed across retries and persisted for held approvals. */
	readGuards?: ReadGuards;
	/**
	 * Rule 38e: the direct pieces are `erased` revisions. Remove drops every revision of every deleted row; anonymise
	 * drops `purge` fields from the targets' earlier revisions (a revision left empty goes). Durable audit defers the
	 * history purge until complete external acknowledgement. Both drop notices linking a deleted row.
	 */
	erase?:
		| { mode: 'remove' }
		| { mode: 'anonymise'; model: string; ids: readonly string[]; purge: readonly string[] };
	/** Recorded actions may contain several independent erasures alongside ordinary writes. */
	erasures?: readonly NonNullable<Commit['erase']>[];
	/** Per-record restores: each record's direct revision is recorded `restored` from `revision`. */
	restored?: readonly { model: string; id: string; revision: number }[];
};
type Piece = { name: string; table: string; op: Write['op']; cascade: boolean };

/** One RETURNING shape for every row piece: its model, id, revision, op, cause, erasure flag and both images. */
const RETURNING = (table: string, op: 'create' | 'update' | 'delete', cause: string, erased = 'false') =>
	`RETURNING ${literal(table)}::text AS c, ${op === 'delete' ? 'old' : 'new'}.id::text AS id, ${op === 'delete' ? 'old.revision + 1' : 'new.revision'}::int AS revision,
	'${op}'::text AS op, ${cause}::text AS cause, ${erased} AS erased,
	${op === 'create' ? 'NULL::jsonb' : 'to_jsonb(old)'} AS o, ${op === 'delete' ? 'NULL::jsonb' : 'to_jsonb(new)'} AS n`;
const union = (pieces: readonly Piece[]) =>
	pieces
		.map((p) => `SELECT c, id, revision, op, cause, erased, o, n FROM ${p.name}`)
		.join(' UNION ALL ');

type Rollup = { field: string; child: string; fk: string; where: Where | undefined } &
	({ kind: 'count' } | { kind: 'sum'; childField: string });
/** Roll-up fields of `model`: `{ kind: 'sum', of: 'lines.amount' }` / `{ kind: 'count', of: 'lines' }` with their `where`. */
export function rollups(m: EngineManifest, cat: Catalog, model: string): readonly Rollup[] {
	return Object.entries(m.models[model]?.fields ?? {}).flatMap<Rollup>(([field, k]) => {
		if (k.kind !== 'sum' && k.kind !== 'count') return [];
		const [relName, childField] = k.of.split('.');
		const rel = relName === undefined ? undefined : cat.models.get(model)?.many.get(relName);
		if (rel === undefined)
			throw BoltError.make('invalid_spec', 'decode', `The roll-up '${model}.${field}' has no declared child path.`);
		const shared = { field, child: rel.child, fk: rel.column, where: k.where };
		if (k.kind === 'count') return [{ ...shared, kind: 'count' }];
		if (childField === undefined)
			throw BoltError.make('invalid_spec', 'decode', `The roll-up '${model}.${field}' has no child field.`);
		return [{ ...shared, kind: 'sum', childField }];
	});
}

type Fold = { field: string; rd: string };
const rollupValue = (fold: Fold, base: string, id: string) =>
	`${base} + coalesce((SELECT sum(d) FROM ${fold.rd} WHERE pid = ${id}), 0)`;
const rollupDelta = Effect.fnUntraced(function* (
	m: EngineManifest,
	cat: Catalog,
	c: Chain,
	rollup: Rollup,
	source: string
) {
	const where = rollup.where === undefined ? 'true' : yield* toOwnSql(m, rollup.child, rollup.where, 's.row', c);
	const side = (image: 'o' | 'n', sign: string) =>
		`SELECT (s.row).${q(rollup.fk)} AS pid, ${sign}${rollup.kind === 'count' ? '1' : `coalesce((s.row).${q(rollup.childField)}, 0)`} AS d, s.erased
		FROM (SELECT jsonb_populate_record(${null_row_sql(rollup.child, cat.models.get(rollup.child)?.fields.keys() ?? [])}, x.${image}) AS row, x.erased
			FROM (${source}) x WHERE x.${image} IS NOT NULL) s
		WHERE ${where}`;
	return `${side('o', '-')} UNION ALL ${side('n', '')}`;
});
const derivedRollup = (table: string, folds: readonly Fold[], stamps: readonly string[], exclude: string): string => {
	const sources = `(${folds.map((fold) => `SELECT pid, erased FROM ${fold.rd}`).join(' UNION ALL ')})`;
	const erased = `EXISTS (SELECT 1 FROM ${sources} source WHERE source.pid = new.id AND source.erased)
		AND NOT EXISTS (SELECT 1 FROM ${sources} source WHERE source.pid = new.id AND NOT source.erased)`;
	return `UPDATE ${q(table)} t SET ${[
		...folds.map((fold) => `${q(fold.field)} = ${rollupValue(fold, `t.${q(fold.field)}`, 't.id')}`),
		'revision = t.revision + 1', ...stamps
	].join(', ')}
	WHERE t.id IN (${folds.map((fold) => `SELECT pid FROM ${fold.rd} GROUP BY pid HAVING sum(d) <> 0`).join(' UNION ')})${exclude} AND ${GATED}
	${RETURNING(table, 'update', "'derived'", erased)}`;
};

/** A `seq` pattern's text around its counter, the period tokens resolved (`'PO-{yyyy}-{0000}'` → `PO-2026-`, 4, ``). */
export function seqParts(
	pattern: string | undefined,
	date: { yyyy: string; mm: string }
): { pre: string; width: number; post: string } {
	const dated = (pattern ?? '{0}')
		.replaceAll('{yyyy}', date.yyyy)
		.replaceAll('{yy}', date.yyyy.slice(2))
		.replaceAll('{mm}', date.mm);
	const counter = /\{0+\}/.exec(dated);
	return counter === null
		? { pre: dated, width: 1, post: '' }
		: {
				pre: dated.slice(0, counter.index),
				width: counter[0].length - 2,
				post: dated.slice(counter.index + counter[0].length)
			};
}
/** A counter's scope in `bolt_seq`: the pattern period and the `per` values. */
export const seqScope = (pre: string, post: string, per: readonly Json[]): string =>
	JSON.stringify([pre, post, ...per]);
const sequenceKey = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String]))
);
/**
 * `seq` counters the act draws from (host side): one entry per counter key and its format, and per created row and
 * field the counter's index and how far the row sits back from the counter's new value.
 */
function seqMeta(m: EngineManifest, writes: readonly Write[], today: string) {
	const counters = new Map<string, { i: number; c: number; pre: string; width: number; post: string; text: boolean }>();
	const rows = new Map<Write, Record<string, [number, number]>>();
	const placed: { w: Write; field: string; key: string; index: number }[] = [];
	for (const w of writes) {
		if (w.op !== 'create' || w.revision !== undefined) continue;
		for (const [field, k] of Object.entries(m.models[w.model]?.fields ?? {})) {
			if (k.kind !== 'seq') continue;
			const { pre, width, post } = seqParts(k.pattern, { yyyy: today.slice(0, 4), mm: today.slice(5, 7) });
			const key = JSON.stringify([w.model, field, seqScope(pre, post, (k.per ?? []).map((p) => w.values[p] ?? null))]);
			const counter = counters.get(key) ?? { i: counters.size, c: 0, pre, width, post, text: k.pattern !== undefined };
			counters.set(key, counter);
			placed.push({ w, field, key, index: counter.c++ });
		}
	}
	for (const { w, field, key, index } of placed) {
		const counter = counters.get(key);
		if (counter === undefined) throw BoltError.make('corrupt', 'derive', 'The sequence plan has no counter.');
		rows.set(w, { ...rows.get(w), [field]: [counter.i, counter.c - 1 - index] });
	}
	return { counters, rows };
}

/** A row piece's group in the act's one data parameter: its model, op, erasure and column shape. */
type Group = { table: string; op: Write['op']; erased: boolean; first: Write; columns: readonly string[]; g: number };
/** The edge an FK column of `child` draws to `parent`, as its physical column and type. */
const edgeColumn = (cat: Catalog, child: string, fk: string, parent: string) => {
	const targets = cat.models.get(child)?.one.get(fk)?.targets ?? [parent];
	const column = targets.length > 1 ? `${fk}__${parent}` : fk;
	const pg = [...(cat.models.get(child)?.fields.values() ?? [])].find((f) => f.column === column)?.pg ?? 'text';
	return { column, pg };
};

export const compileCommit = Effect.fn('Bolt.compileCommit')(function* (
	m: EngineManifest,
	cat: Catalog,
	x: Commit,
	audit?: AuditMutation
): Effect.fn.Return<Sql, BoltError> {
	const c = new Chain();
	const erasures = x.erasures ?? (x.erase === undefined ? [] : [x.erase]);
	const by = actor_id(x.actor);
	const now = `${c.shared('now', x.now)}::timestamptz`;
	const byText = by === null ? 'NULL::text' : `${c.shared('by', by)}::text`;
	const anonymised = erasures.flatMap((spec) =>
		spec.mode === 'anonymise'
			? [`(SELECT jsonb_object_agg(${literal(spec.model)} || '/' || id, ${c.p(spec.purge)}::jsonb) FROM jsonb_array_elements_text(${c.p(spec.ids)}::jsonb) id)`]
			: []
	);
	gate(c, x.key, x.digest, x.issuedAt, {
		store: `jsonb_build_object('mode', ${(x.restored?.length ?? 0) > 0 ? "'restore'" : "'write'"}, 'actor', ${byText}, 'at', ${now})`,
		...(anonymised.length === 0 ? {} : { anonymise: anonymised.join(' || ') })
	});
	rate(c, x.rate);
	x.before?.(c);
	fingerprintAsserts(c, [...(x.fingerprints ?? []), ...(x.readGuards?.fingerprints ?? [])]);
	if (x.readGuards?.inconsistent === true) c.assert('false', 'fingerprint');
	const operation = audit === undefined ? 'NULL::text' : `${c.shared('operation', audit.event.operation_id)}::text`;
	if (audit !== undefined) {
		c.cte('receipt', auditReceipt(audit, (role, value) => c.shared(role, value)));
		if ((audit.acknowledge?.length ?? 0) > 0 && erasures.length === 0)
			c.cte('acknowledged', `UPDATE bolt_audit_receipt SET acknowledged_at=clock_timestamp()
	WHERE operation IN (SELECT jsonb_array_elements_text(${c.p(audit.acknowledge ?? [])}::jsonb)) AND acknowledged_at IS NULL AND expired_at IS NULL`);
	}
	/** The engine columns a model declares, stamped from the act's one `now` and actor (a system table may declare few). */
	const stamps = (table: string, op: 'create' | 'update', given: readonly string[] = []) => {
		const fields = cat.models.get(table)?.fields;
		return Object.entries({
			updated_at: now,
			updated_by: byText,
			...(op === 'create' ? { created_at: now, created_by: byText } : {})
		}).filter(([k]) => fields?.has(k) === true && !given.includes(k));
	};

	// the act's rows, each sent once in input order; every row piece reads its group from here
	const seq = seqMeta(m, x.writes, x.today);
	const groups = new Map<string, Group>();
	const data = x.writes.map((w) => {
		const fields = cat.models.get(w.model)?.fields;
		if (fields === undefined)
			throw BoltError.make('invalid_spec', 'decode', `The write names an unknown model '${w.model}'.`);
		const values =
			w.op === 'delete'
				? {}
				: Object.fromEntries(Object.entries(w.op === 'create' ? w.values : w.set).flatMap(([k, v]) => cells(k, v, fields.get(k))));
		const row: Record<string, Json> = {
			...values,
			id: w.id,
			...(w.op === 'create' ? (w.revision === undefined ? {} : { revision: w.revision }) : { revision: w.revision })
		};
		const erased = w.erased ?? x.erase !== undefined;
		const key = [w.model, w.op, erased, ...Object.keys(row).sort()].join('\0');
		const group = groups.get(key) ?? { table: w.model, op: w.op, erased, first: w, columns: Object.keys(row), g: groups.size };
		groups.set(key, group);
		const counters = seq.rows.get(w);
		return { ...row, $g: group.g, ...(counters === undefined ? {} : { $seq: counters }) };
	});
	c.cte('input', `SELECT e.j, e.ord, (e.j->>'$g')::int AS g FROM jsonb_array_elements(${c.p(data)}::jsonb) WITH ORDINALITY AS e(j, ord)`);
	if (seq.counters.size > 0) {
		c.cte(
			'seqs',
			`SELECT * FROM jsonb_to_recordset(${c.p([...seq.counters].map(([key, s]) => ({ ...s, k: sequenceKey(key) })))}::jsonb)
	AS v(i int, k jsonb, c int, pre text, width int, post text, text boolean)`
		);
		// `bolt_seq (model, field, scope, value)` is the schema area's; `key` is the three as a JSON array
		c.cte(
			'seq',
			`INSERT INTO bolt_seq (model, field, scope, value) SELECT v.k->>0, v.k->>1, v.k->>2, v.c FROM seqs v
	WHERE ${GATED} ON CONFLICT (model, field, scope) DO UPDATE SET value = bolt_seq.value + excluded.value
	RETURNING jsonb_build_array(model, field, scope) AS key, value AS n`
		);
		c.cte('seqv', 'SELECT v.*, s.n FROM seq s JOIN seqs v ON v.k = s.key');
	}
	const inGroup = (group: Group) => `input e, jsonb_populate_record(${null_row_sql(group.table, cat.models.get(group.table)?.fields.keys() ?? [])}, e.j) r WHERE e.g = ${group.g}`;
	const missing = (group: Group, piece: string) =>
		`(SELECT jsonb_build_object('model', ${literal(group.table)}, 'ids', jsonb_agg(e.j->>'id'))::text FROM input e
	WHERE e.g = ${group.g} AND e.j->>'id' NOT IN (SELECT id FROM ${piece}))`;

	// an owned child's direct write holds its parent in an admitting state. The child piece reads the assert, so
	// the parent's `FOR SHARE` is taken before any piece of this statement changes that parent (a row the statement
	// already changed would be skipped by `FOR SHARE`, not re-tested)
	const held = new Map<string, string>();
	for (const o of x.owned) {
		const ids = c.p(o.ids);
		const a = c.assert(
			`(SELECT count(*) FROM (SELECT 1 FROM ${q(o.parent)} p WHERE id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
	AND ${yield* own_pred_sql(o.where, 'p.', c, true).pipe(Effect.mapError(from_store))} FOR SHARE) s) = jsonb_array_length(${ids}::jsonb)`,
			'locked'
		);
		held.set(o.child, `${held.has(o.child) ? `${held.get(o.child)} AND ` : ''}(SELECT count(*) FROM ${a}) >= 0`);
	}
	const guard = (table: string) => (held.has(table) ? `${GATED} AND ${held.get(table)}` : GATED);
	const pieces: Piece[] = [];
	const on = (table: string) => pieces.filter((p) => p.table === table);
	let n = 0;
	const add = (table: string, op: Write['op'], sql: string, counted?: Group): string => {
		const name = c.cte(`p${n++}`, sql);
		pieces.push({ name, table, op, cascade: false });
		if (counted !== undefined)
			c.assertWith(
				`(SELECT count(*) FROM ${name}) = (SELECT count(*) FROM input WHERE g = ${counted.g})`,
				'conflict',
				missing(counted, name)
			);
		return name;
	};
	const byOp = (op: Write['op']) => [...groups.values()].filter((group) => group.op === op);
	const cause = (group: Group) => (group.erased ? "'erased'" : "'direct'");

	// Deletes, then the referential actions they imply: explicit pieces, so every cascaded or unlinked row is in
	// this statement's images and history. The foreign keys keep their declared actions as the raw-SQL path and a
	// safety net; by the time they run at the end of the statement, no referencing row is left for them.
	const deleteOrder: string[] = [];
	const deleteTables = new Set(byOp('delete').map((group) => group.table));
	const visitDelete = (table: string, seen: Set<string>) => {
		if (deleteOrder.includes(table) || seen.has(table)) return;
		seen.add(table);
		for (const relation of relations(m).all)
			if (relation.targets.includes(table) && deleteTables.has(relation.from)) visitDelete(relation.from, seen);
		deleteOrder.push(table);
	};
	for (const table of deleteTables) visitDelete(table, new Set());
	let previousDelete: string | undefined;
	for (const table of deleteOrder)
		for (const group of byOp('delete').filter((group) => group.table === table))
			previousDelete = add(
				table,
				'delete',
				`DELETE FROM ${q(table)} t USING ${inGroup(group)}
	AND t.id = r.id AND t.revision = r.revision AND ${guard(table)}${previousDelete === undefined ? '' : ` AND (SELECT count(*) FROM ${previousDelete}) >= 0`}
	${RETURNING(table, 'delete', cause(group), String(group.erased))}`,
				group
			);
	cascades(m, cat, c, pieces, deleteTables, stamps, () => `p${n++}`);

	// creates and updates, children before the parents whose roll-ups they feed
	const order: string[] = [];
	const visit = (t: string, seen: Set<string>) => {
		if (order.includes(t) || seen.has(t)) return;
		seen.add(t);
		for (const r of rollups(m, cat, t)) visit(r.child, seen);
		order.push(t);
	};
	// every model, so a parent the act does not write still takes its derived roll-up write
	for (const t of new Set([...groups.values()].map((group) => group.table).concat(Object.keys(m.models)))) visit(t, new Set());
	for (const table of order) {
		// roll-up deltas from every piece on the child so far (cascades included), new minus old, each side under its `where`
		const folds: Fold[] = [];
		for (const r of rollups(m, cat, table)) {
			const src = on(r.child);
			if (src.length > 0) folds.push({ field: r.field, rd: c.cte(`rd${n++}`, yield* rollupDelta(m, cat, c, r, union(src))) });
		}
		const fields = cat.models.get(table)?.fields;
		if (fields === undefined) continue;
		for (const group of byOp('create').filter((group) => group.table === table)) {
			const cols = group.columns;
			const seqCols = Object.keys(seq.rows.get(group.first) ?? {});
			const seqExpr = (f: string) => {
				const field = fields.get(f);
				if (field === undefined)
					throw BoltError.make('invalid_spec', 'decode', `The sequence names an unknown field '${table}.${f}'.`);
				const at = `(e.j->'$seq'->${literal(f)})`;
				return `(SELECT CASE WHEN s.text THEN s.pre || lpad((s.n - (${at}->>1)::int)::text, greatest(s.width, length((s.n - (${at}->>1)::int)::text)), '0') || s.post
		ELSE (s.n - (${at}->>1)::int)::text END FROM seqv s WHERE s.i = (${at}->>0)::int)::${field.pg}`;
			};
			const system = stamps(table, 'create', cols);
			const revision = fields.has('revision') && !cols.includes('revision') ? [['revision', '1'] as const] : [];
			const all = [...cols, ...system.map(([k]) => k), ...revision.map(([k]) => k), ...seqCols, ...folds.map((f) => f.field)];
			add(
				table,
				'create',
				`INSERT INTO ${q(table)} (${all.map(q).join(', ')})
	SELECT ${[...cols.map((k) => `r.${q(k)}`), ...system.map(([, v]) => v), ...revision.map(([, v]) => v), ...seqCols.map(seqExpr), ...folds.map((f) => rollupValue(f, '0', 'r.id'))].join(', ')}
	FROM ${inGroup(group)} AND ${guard(table)} ${RETURNING(table, 'create', cause(group), String(group.erased))}`
			);
		}
		for (const group of byOp('update').filter((group) => group.table === table)) {
			const sets = group.columns
				.filter((k) => k !== 'id' && k !== 'revision')
				.map((k) => `${q(k)} = r.${q(k)}`);
			add(
				table,
				'update',
				`UPDATE ${q(table)} t SET ${[...sets, ...stamps(table, 'update', group.columns).map(([k, v]) => `${q(k)} = ${v}`), ...folds.map((f) => `${q(f.field)} = ${rollupValue(f, `t.${q(f.field)}`, 't.id')}`), 'revision = t.revision + 1'].join(', ')}
	FROM ${inGroup(group)} AND t.id = r.id AND t.revision = r.revision AND ${guard(table)} ${RETURNING(table, 'update', cause(group), String(group.erased))}`,
				group
			);
		}
		// rows the act did not write whose roll-ups moved: one derived write each, never twice in one statement
		if (folds.length > 0)
			add(
				table,
				'update',
				derivedRollup(
					table,
					folds,
					stamps(table, 'update').filter(([k]) => k === 'updated_at').map(([k, v]) => `${q(k)} = ${v}`),
					on(table).map((p) => ` AND t.id::text NOT IN (SELECT id FROM ${p.name})`).join('')
				)
			);
	}

	const hasWrites = pieces.length > 0;
	c.cte('allp', hasWrites ? union(pieces) : 'SELECT NULL::text AS c, NULL::text AS id, NULL::int AS revision, NULL::text AS op, NULL::text AS cause, false AS erased, NULL::jsonb AS o, NULL::jsonb AS n WHERE false');
	// the approval lock (lock.ts); a decision's own rollback is the request's, and a new request holds no row yet
	const hit =
		x.rollback !== true && hasWrites
			? lockPieces(m, cat, c, x.actor, 'allp', x.approvalDecision?.request, x.resubmit?.request)
			: null;
	if (x.approvalDecision !== undefined && hit !== null)
		c.assertWith(
			`NOT EXISTS (SELECT 1 FROM ${hit})`,
			'under_approval',
			`(SELECT id::text || ' An approval decision cannot change another held request.' FROM ${hit} LIMIT 1)`
		);
	// built only when used: an unused parameter has no type PostgreSQL can determine
	const request = () =>
		x.approval !== undefined
			? `coalesce(${hit === null ? 'NULL' : `(SELECT id FROM ${hit} LIMIT 1)`}, ${c.p(x.approval.request_id)}::uuid)`
			: x.approvalDecision !== undefined
				? `${c.p(x.approvalDecision.request)}::uuid`
				: hit === null
					? 'NULL::uuid'
					: `(SELECT id FROM ${hit} LIMIT 1)`;
	// history for every row piece of a model keyed by uuid (other keys keep none)
	const historied = pieces.filter((piece) => cat.models.get(piece.table)?.fields.get('id')?.pg === 'uuid');
	if (historied.length > 0) {
		c.cte(
			'history_source',
			`SELECT x.*, ${now} AS at, ${c.shared('actor', actor_ref(x.actor))}::text AS actor FROM (${union(historied)}) x
	${erasures.some((spec) => spec.mode === 'remove') ? "WHERE NOT x.erased OR x.op <> 'delete' OR x.cause = 'erased'" : ''}`
		);
		history_piece(c, 'history_source', { restored: x.restored ?? [], request: request(), operation, uuid: true });
	}
	x.approval?.pieces(c, hit);
	x.resubmit?.pieces(c, hit);
	if (erasures.length > 0 && hasWrites) erasePieces(c, erasures, audit === undefined ? null : operation);
	c.cte('effectp', 'SELECT * FROM allp WHERE NOT erased');
	if (x.rollback !== true && x.approvalDecision?.stands !== false) {
		const requests = [
			...(hit === null ? [] : [`SELECT id,records FROM ${hit}`]),
			...(x.approval === undefined ? [] : ['SELECT id,records FROM ap_state'])
		];
		queue_effects(m, c, x.now, x.writer, 'effectp', x.key, requests.length === 0 ? null : c.cte('effect_requests', requests.join(' UNION ALL ')));
	}
	// a sync write is irreversible: a record an approval request holds queues only once it is approved (approvals.ts),
	// generic rollback skips this hook; the sync rollback owner explicitly queues its peers' recovery images
	// (a routed write that joined an open request queues what that request does not hold; one that opened its own, nothing)
	if (x.approvalDecision === undefined && x.rollback !== true && (x.approval === undefined || hit !== null))
		syncOutboxPiece(
			m,
			c,
			x.now,
			new Set(pieces.map((piece) => piece.table)),
			x.actor,
			hit === null
				? 'effectp'
				: c.cte(
						'effect_free',
						`SELECT * FROM effectp x WHERE NOT EXISTS (SELECT 1 FROM ${hit} h CROSS JOIN LATERAL jsonb_array_elements(h.records) r
	WHERE r ->> 'collection' = x.c AND r ->> 'id' = x.id)${x.approval === undefined ? '' : ` AND EXISTS (SELECT 1 FROM ${hit})`}`
					)
		);
	if (x.runs.length > 0) enqueue(c, x.runs, { when: GATED, conflict: 'replace' });
	if (x.notices.length > 0) noticeInsert(c, 'notices', x.notices, x.now, GATED, m.teams, m.workspace.signup?.policies);
	x.pieces?.(c); // hook:syncs

	// in the act's own order (the input's; `records[0]` is what was written), anything else after by model and id
	const records = `(SELECT coalesce(jsonb_agg(jsonb_build_object('model', x.c, 'id', x.id, 'revision', x.revision) ORDER BY i.ord NULLS LAST, x.c, x.id), '[]'::jsonb)
	FROM allp x LEFT JOIN input i ON i.j->>'id' = x.id WHERE x.cause IN ('direct', 'erased'))`;
	const commitOutcome = () =>
		`jsonb_build_object('kind', 'committed', 'output', ${c.p(JSON.stringify(x.output))}::jsonb, 'records', ${records}${x.unchanged === undefined ? '' : `, 'unchanged', ${c.p(JSON.stringify(x.unchanged))}::jsonb`})`;
	const outcome =
		x.resubmit?.pending === true
			? `jsonb_build_object('kind', 'pending_approval', 'request_id', ${c.p(x.resubmit.request)}::text, 'records', ${records})`
			: x.approval === undefined
				? commitOutcome()
				: `CASE WHEN ${hit === null ? 'false' : `EXISTS (SELECT 1 FROM ${hit})`} THEN ${commitOutcome()}
	ELSE jsonb_build_object('kind', 'pending_approval', 'request_id', ${c.p(x.approval.request_id)}::text, 'records', ${records}) END`;
	const result = answer(c, x.key, x.digest, outcome);
	const tables = affectedTables(m, cat, x.writes);
	return c.sql(
		`${result}, (SELECT coalesce(jsonb_agg(jsonb_build_object('model', c, 'id', id, 'op', op, 'revision', revision, 'transaction', pg_current_xact_id()::text,
	'old', ${storedImageSql(cat, tables, 'o')}, 'new', ${storedImageSql(cat, tables, 'n')}, 'cause', cause)), '[]'::jsonb) FROM allp) || ${captureRows(c)} AS captured, ${next_due(c)} AS next_due,
	(SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM allp WHERE c = 'sys_integration'
	AND (o IS NULL OR n IS NULL OR (o->'configuration', o->'active', o->'integration', o->'envoy', o->'import_start')
	IS DISTINCT FROM (n->'configuration', n->'active', n->'integration', n->'envoy', n->'import_start'))) AS changed_instances, ${x.readGuards === undefined ? 'false' : GATED} AS read_guards_applied${x.approvalDecision !== undefined ? ', (SELECT count(*) FROM up)::int AS approval_decided' : ''}${
			audit === undefined
				? ''
				: `, jsonb_build_object('at', ${now}::text, 'committed_at', ${c.shared('audit_at', audit.event.at)}::timestamptz::text, 'records', ${historied.length === 0 ? "'[]'::jsonb" : `(SELECT coalesce(jsonb_agg(jsonb_build_object('model', x.c, 'id', x.id, 'revision', x.revision, 'op', x.op, 'cause', x.cause,
	'old', x.o - ${UNHISTORIED}, 'new', x.n - ${UNHISTORIED}) ORDER BY x.c, x.id, x.revision), '[]'::jsonb) FROM history_source x)`}) AS audited`
		}`
	);
});


/**
 * The referential actions a statement's deletes imply, as pieces of the same statement: each `cascade` child deleted
 * and each `set_null` child unlinked once, parents before children, a self-referencing tree followed to its leaves.
 * A row the act also writes directly is a conflict: one statement changes a row once.
 */
function cascades(
	m: EngineManifest,
	cat: Catalog,
	c: Chain,
	pieces: Piece[],
	deleted: ReadonlySet<string>,
	stamps: (table: string, op: 'update') => (readonly [string, string])[],
	name: () => string
): void {
	type Edge = { child: string; parent: string; column: string; pg: string; action: 'cascade' | 'set_null' };
	const edges: Edge[] = relations(m).all.flatMap((rel) => {
		const action = rel.spec.on_delete ?? (rel.spec.owned === true ? 'cascade' : 'restrict');
		// a system table's own referential actions stay its foreign keys': it keeps no workspace history
		if (action === 'restrict' || m.models[rel.from]?.table !== undefined) return [];
		return rel.targets.map((parent) => ({ child: rel.from, parent, action, ...edgeColumn(cat, rel.from, rel.fk, parent) }));
	});
	const owned = edges.filter((edge) => edge.action === 'cascade');
	// the tables the deletes reach, each after every other table that cascades into it
	const reach = new Set<string>(deleted);
	for (const table of reach)
		for (const edge of owned) if (edge.parent === table) reach.add(edge.child);
	const order: string[] = [];
	const visit = (table: string, path: ReadonlySet<string>) => {
		if (order.includes(table)) return;
		if (path.has(table))
			throw BoltError.make('invalid_spec', 'decode', `The owned relationships through '${table}' form a cycle a delete cannot follow.`);
		for (const edge of owned)
			if (edge.child === table && edge.parent !== table && reach.has(edge.parent)) visit(edge.parent, new Set([...path, table]));
		order.push(table);
	};
	for (const table of reach) visit(table, new Set());

	const removed = (table: string) => pieces.filter((p) => p.table === table && p.op === 'delete');
	const deletes = (table: string) => removed(table).map((p) => `SELECT id, erased FROM ${p.name}`).join(' UNION ALL ');
	const referencing = (edge: Edge) =>
		`SELECT t.id::text AS id, p.erased FROM ${q(edge.child)} t JOIN (${deletes(edge.parent)}) p ON t.${q(edge.column)} = p.id::${edge.pg}`;
	/** The targets keyed by `table`'s own id, less the rows its earlier pieces already delete. */
	const targets = (table: string, from: string) => {
		const id = cat.models.get(table)?.fields.get('id')?.pg ?? 'text';
		return c.cte(
			name(),
			`SELECT t.id::${id} AS id, bool_or(t.erased) AS erased FROM (${from}) t
	WHERE ${removed(table).map((p) => `t.id NOT IN (SELECT id FROM ${p.name})`).join(' AND ') || 'true'} GROUP BY t.id`
		);
	};
	const piece = (table: string, op: 'delete' | 'update', target: string, sql: string) => {
		const id = c.cte(name(), sql);
		pieces.push({ name: id, table, op, cascade: true });
		c.assertWith(`(SELECT count(*) FROM ${id}) = (SELECT count(*) FROM ${target})`, 'conflict',
			`(SELECT jsonb_build_object('model', ${literal(table)}, 'ids', jsonb_agg(x.id::text))::text FROM ${target} x WHERE x.id::text NOT IN (SELECT id FROM ${id}))`);
	};
	for (const table of order) {
		const into = owned.filter((edge) => edge.child === table && removed(edge.parent).length > 0 && edge.parent !== table);
		const tree = owned.filter((edge) => edge.child === table && edge.parent === table);
		if (into.length === 0 && (tree.length === 0 || removed(table).length === 0)) continue;
		const base = [...into, ...tree].map(referencing).join(' UNION ALL ');
		const target = targets(
			table,
			tree.length === 0
				? base
				: `WITH RECURSIVE reached(id, erased) AS (${base} UNION ${tree
						.map((edge) => `SELECT t.id::text, r.erased FROM ${q(table)} t JOIN reached r ON t.${q(edge.column)} = r.id::${edge.pg}`)
						.join(' UNION ')}) SELECT * FROM reached`
		);
		piece(table, 'delete', target,
			`DELETE FROM ${q(table)} t USING ${target} x WHERE t.id = x.id AND ${GATED} ${RETURNING(table, 'delete', "'cascade'", 'x.erased')}`);
	}
	for (const table of new Set(edges.filter((edge) => edge.action === 'set_null').map((edge) => edge.child))) {
		const unlinked = edges.filter((edge) => edge.child === table && edge.action === 'set_null' && removed(edge.parent).length > 0);
		if (unlinked.length === 0) continue;
		const target = targets(table, unlinked.map(referencing).join(' UNION ALL '));
		piece(table, 'update', target,
			`UPDATE ${q(table)} t SET ${[
				...unlinked.map((edge) => `${q(edge.column)} = CASE WHEN t.${q(edge.column)}::text IN (SELECT id FROM (${deletes(edge.parent)}) p) THEN NULL ELSE t.${q(edge.column)} END`),
				...stamps(table, 'update').map(([k, v]) => `${q(k)} = ${v}`),
				'revision = t.revision + 1'
			].join(', ')}
	FROM ${target} x WHERE t.id = x.id AND ${GATED} ${RETURNING(table, 'update', "'cascade'", 'x.erased')}`);
	}
}

/** The native action closure also bounds numeric decoding and locks before any domain mutation. */
export function affectedTables(
	m: EngineManifest,
	cat: Catalog,
	writes: readonly Write[]
): string[] {
	const affected = new Set(writes.map((write) => write.model));
	const deleted = new Set(
		writes.filter((write) => write.op === 'delete').map((write) => write.model)
	);
	for (let changed = true; changed;) {
		changed = false;
		for (const relation of relations(m).all) {
			if (!relation.targets.some((target) => deleted.has(target))) continue;
			const action =
				relation.spec.on_delete ?? (relation.spec.owned === true ? 'cascade' : 'restrict');
			if (action === 'restrict') continue;
			if (!affected.has(relation.from)) {
				affected.add(relation.from);
				changed = true;
			}
			if (action === 'cascade' && !deleted.has(relation.from)) {
				deleted.add(relation.from);
				changed = true;
			}
		}
		for (const table of Object.keys(m.models))
			if (
				!affected.has(table) &&
				rollups(m, cat, table).some((rollup) => affected.has(rollup.child))
			) {
				affected.add(table);
				changed = true;
			}
	}
	return [...affected].sort();
}

/**
 * The outcome record: a refusal or conflict decided after guest code or inside Postgres, recorded with the
 * rate increment so a replay answers it without re-running guest code, and so refused attempts count.
 */
export function compile_outcome_record(
	x: Pick<Commit, 'key' | 'digest' | 'issuedAt' | 'rate'>,
	outcome: Json
): Sql {
	const c = new Chain();
	gate(c, x.key, x.digest, x.issuedAt);
	rate(c, x.rate);
	return c.sql(
		`${answer(c, x.key, x.digest, `${c.p(JSON.stringify(outcome))}::jsonb`)}, '[]'::jsonb AS captured, NULL::timestamptz AS next_due, '[]'::jsonb AS changed_instances`
	);
}

/** Columns history never keeps: the generated search document and the platform embedding. */
const UNHISTORIED = `ARRAY['bolt_search', 'bolt_embedding', 'bolt_record_label']`;
/**
 * Rule 38e(a–c): purge prior history and notices while retaining the direct erasure's own receipt. With durable audit
 * (`operation`, the statement's audit operation) the purge waits for the external acknowledgement instead.
 */
function erasePieces(c: Chain, erasures: readonly NonNullable<Commit['erase']>[], operation: string | null): void {
	// A request holding an erased row goes with it: its log names the record and may quote it.
	purgeProposals(
		c,
		`${GATED} AND EXISTS (
		SELECT 1 FROM allp x WHERE x.erased AND (x.op = 'delete' OR x.cause = 'erased') AND (
			(a.collection = x.c AND a.record = x.id)
			OR a.records @> jsonb_build_array(jsonb_build_object('collection', x.c, 'id', x.id))))`,
		`${GATED} AND EXISTS (SELECT 1 FROM allp x WHERE x.erased AND x.op = 'delete' AND n.link ->> 'model' = x.c AND n.link ->> 'id' = x.id)`
	);
	if (erasures.some((e) => e.mode === 'remove'))
		c.cte(
			'erase_removed',
			operation !== null
				? `INSERT INTO bolt_audit_erase(operation,collection,record,revision,mode,keep_marker)
			SELECT ${operation},x.c,x.id::uuid,x.revision,'remove',x.cause='erased'
			FROM allp x WHERE x.erased AND x.op='delete' AND x.id ~* '${UUID_PATTERN.source}' AND ${GATED}
			ON CONFLICT DO NOTHING RETURNING record`
				: `DELETE FROM bolt_history h USING allp x WHERE x.erased AND x.op = 'delete' AND bolt_history_matches(h.collection,h.meta,x.c) AND h.record::text = x.id
			AND NOT (x.cause='erased' AND h.revision=x.revision) AND ${GATED}`
		);
	for (const [index, e] of erasures.entries()) {
		if (e.mode === 'remove') continue;
		const fields = `ARRAY(SELECT jsonb_array_elements_text(${c.p(e.purge)}::jsonb))`;
		const ids = `(SELECT jsonb_array_elements_text(${c.p(e.ids)}::jsonb))`;
		if (operation !== null) {
			c.cte(
				`erase_anonymised${index}`,
				`INSERT INTO bolt_audit_erase(operation,collection,record,revision,mode,purge,keep_marker)
			SELECT ${operation},x.c,x.id::uuid,x.revision,'anonymise',${fields},true FROM allp x
			WHERE x.c=${literal(e.model)} AND x.id IN ${ids} AND ${GATED} ON CONFLICT DO NOTHING RETURNING record`
			);
			continue;
		}
		const historicalFields = `bolt_history_purge_fields(h.meta->>'schema',${literal(e.model)},${fields})`;
		const at = `bolt_history_matches(h.collection,h.meta,${literal(e.model)}) AND h.record::text IN ${ids} AND h.changes ?| ${historicalFields}
		AND h.revision < (SELECT min(x.revision) FROM allp x WHERE x.c=${literal(e.model)} AND x.id=h.record::text)`;
		c.cte(
			`purge${index}`,
			`UPDATE bolt_history h SET changes = h.changes - ${historicalFields} WHERE ${at} AND (h.changes - ${historicalFields} <> '{}'::jsonb OR h.cause='erased') AND ${GATED}`
		);
		c.cte(
			`purge_empty${index}`,
			`DELETE FROM bolt_history h WHERE ${at} AND h.cause<>'erased' AND h.changes - ${historicalFields} = '{}'::jsonb AND ${GATED}`
		);
	}
}

/**
 * Persist the authored revision from an identified source's row images (`c, id, revision, at, actor, op, cause, erased,
 * o, n`); a restore marks its records' direct revisions. `uuid`: every source id is a uuid key, so none is tested.
 */
export function history_piece(
	c: Chain,
	source: string,
	options: {
		readonly restored?: Commit['restored'];
		readonly request?: string;
		readonly operation?: string;
		readonly uuid?: true;
	} = {}
): void {
	const restored = options.restored ?? [];
	const keyed = options.uuid === true ? `${source} x` : `(SELECT * FROM ${source} x WHERE x.id::text ~* '${UUID_PATTERN.source}') x`;
	const versions = c.cte(
		`${source}_versions`,
		`SELECT current.model, current.schema::text AS schema FROM bolt_history_current current
	JOIN bolt_history_schema definition ON definition.id=current.schema AND definition.model=current.model
	WHERE current.active AND current.model IN (SELECT DISTINCT c FROM ${source})`
	);
	c.assert(
		`NOT EXISTS (SELECT 1 FROM ${keyed} WHERE x.c NOT IN (SELECT model FROM ${versions}))`,
		'schema',
		'History requires a registered schema version',
		'true'
	);
	const marks =
		restored.length === 0
			? null
			: c.p(Object.fromEntries(restored.map((r) => [`${r.model}/${r.id}`, r.revision])));
	const mark = marks === null ? 'false' : `(x.cause = 'direct' AND ${marks}::jsonb ? (x.c || '/' || x.id))`;
	const from = marks === null ? 'NULL::int' : `(${marks}::jsonb ->> (x.c || '/' || x.id))::int`;
	c.cte(
		`history_${source}`,
		`INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, changes, restored_from, request, operation, meta)
	SELECT x.c, x.id::uuid, x.revision, x.at, x.actor, x.op, CASE WHEN ${mark} THEN 'restored' ELSE x.cause END,
		CASE WHEN x.op='create' OR (x.erased AND x.op='update') OR version.full THEN x.n - ${UNHISTORIED} WHEN x.op='delete' THEN '{}'::jsonb
		ELSE (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(x.n) AS e(k, v)
			WHERE k NOT IN ('revision', 'updated_at', 'updated_by') AND k <> ALL (${UNHISTORIED}) AND x.o->k IS DISTINCT FROM v) END,
		CASE WHEN ${mark} THEN ${from} END, ${options.request ?? 'NULL::uuid'}, ${options.operation ?? 'NULL::text'},
		jsonb_build_object('id',x.id,'revision',version.i->'revision','updated_at',version.i->'updated_at','updated_by',version.i->'updated_by','created_at',version.i->'created_at','created_by',version.i->'created_by','schema',v.schema,'full',version.full)
	FROM ${keyed} JOIN ${versions} v ON v.model = x.c
	CROSS JOIN LATERAL (SELECT coalesce(x.n, x.o) AS i, x.op='update' AND NOT EXISTS (SELECT 1 FROM bolt_history h
		WHERE h.collection=x.c AND h.record=x.id::uuid AND h.meta->>'schema'=v.schema) AS full) version`
	);
}
const AuditedRow = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	revision: Schema.Number,
	op: Schema.String,
	cause: Schema.String,
	old: Schema.Json,
	new: Schema.Json
});
export const CommitAnswer = Schema.Struct({
	outcome: Schema.NullOr(WriteOutcome),
	captured: Schema.Array(Captured),
	next_due: Schema.NullOr(Schema.String),
	changed_instances: Schema.Array(Schema.String),
	approval_decided: Schema.optionalKey(Schema.Number),
	read_guards_applied: Schema.optionalKey(Schema.Boolean),
	audited: Schema.optionalKey(Schema.Struct({ at: Schema.String, committed_at: Schema.String, records: Schema.Array(AuditedRow) }))
});
export type CommitAnswer = typeof CommitAnswer.Type;
/**
 * Runs a commit statement with its audit operation inside it: the receipt is a piece of the statement, so no
 * statement wraps it, and the answer carries what the terminal audit event records.
 */
export const runCommit = Effect.fn('Bolt.runCommit')(function* (
	db: TenantDbShape,
	compile: (audit: AuditMutation | undefined) => Effect.Effect<Sql, BoltError>,
	batch: (statement: Sql) => DbBatch,
	actor: EngineActor,
	erase: boolean
) {
	const audit = yield* AuditMutation;
	const statement = yield* compile(audit);
	const results = yield* db.transaction(batch(statement)).pipe(Effect.provideService(AuditMutation, undefined));
	const answers = yield* Schema.decodeUnknownEffect(Schema.Array(CommitAnswer))(results[0]?.rows ?? []).pipe(
		Effect.mapError((error) => BoltError.make('bad_answer', 'commit', error.message, error))
	);
	const answer = answers[0];
	if (audit !== undefined && answer?.audited !== undefined)
		audit.committed.value = {
			outcome: answer.outcome,
			at: answer.audited.at,
			actor: actor_ref(actor),
			committedAt: answer.audited.committed_at,
			records: answer.audited.records,
			erase
		};
	return answers;
});
/** A guarded provisional write and its post-image approval baseline settle in the same locked native batch. */
export const executeCommit = Effect.fn('Bolt.executeCommit')(function* (
	db: TenantDbShape,
	manifest: EngineManifest,
	catalog: Catalog,
	commit: Commit,
	lock?: Lock
) {
	const guards = commit.readGuards;
	const guarded =
		guards !== undefined && (guards.fingerprints.length > 0 || guards.inconsistent === true);
	const tables =
		guarded || lock?.tables !== undefined
			? [
					...new Set([
						...(lock?.tables ?? []),
						...(guards?.tables ?? []),
						...affectedTables(manifest, catalog, commit.writes),
						...(commit.approval === undefined ? [] : ['bolt_approvals', 'approval_request'])
					])
				].sort()
			: lock?.tables;
	const locked: Lock | undefined =
		tables === undefined ? lock : { ...lock, tables, mode: 'SHARE ROW EXCLUSIVE' };
	const answers = yield* runCommit(
		db,
		(audit) => compileCommit(manifest, catalog, commit, audit),
		(statement) => ({
			statements: [
				statement,
				...(guarded && commit.approval !== undefined
					? [readGuardBaseline(commit.approval.request_id, guards, guards.sourceEpoch)]
					: [])
			],
			...(locked === undefined ? {} : { lock: locked })
		}),
		commit.actor,
		(commit.erasures?.length ?? 0) > 0 || commit.erase !== undefined
	);
	return answers.map((answer) => ({ ...answer, captured: storedCaptures(catalog, answer.captured) }));
});

/** SQL owns what was queued and which links changed; publish only after its successful commit. */
export const committed: (
	answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>
) => Effect.Effect<number, never, Live | Wake | Links> = Effect.fn('Bolt.committed')(function* (
	answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>
) {
	const live = yield* Live;
	if (answer.next_due !== null) yield* (yield* Wake).at(answer.next_due);
	if (answer.changed_instances.length > 0) {
		const links = yield* Links;
		yield* Effect.forEach(answer.changed_instances, (instance) => links.changed(instance), {
			discard: true
		});
	}
	return live.publish(answer.captured);
});
