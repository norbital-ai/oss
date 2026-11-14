// One write statement per act, a large one bounded statements of one transaction (`parts`): guarded direct writes and
// the referential actions they imply, roll-ups, row history, approvals, queued runs, notices, the sync outbox and the
// audit receipt, every row image taken from the pieces' RETURNING.
import type { Json } from '../../decl/values.ts';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { DbBatch, Lock, Sql } from '@norbital-ai/host-api';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { Captured, captureRows } from '../db/captured.ts';
import { storedCaptures, storedImageSql } from '../db/stored.ts';
import { readGuardBaseline } from '../approvals/read-guards.ts';
import { Effect, Schema } from 'effect';
import type { NoticeInsert } from '../notifications/notify.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import { utf8Bytes, type EngineActor, type QueuedRun, type RowData } from '../contracts.ts';
import { relations, type EngineManifest } from '../manifest.ts';
import { Live, Wake, Links } from '../services.ts';
import { toOwnSql } from '../access/pred.ts';
import type { Where } from '@norbital-ai/store/kind';
import { q, cells, null_row_sql, type Catalog } from '@norbital-ai/store';
import { enqueue, next_due, PARTS_TABLE, queue_effects, type Writer } from '../runs/queue.ts'; // hook:automations
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

/**
 * One row change as the statement writes it: upserts are already resolved, updates carry the stored revision. A
 * `carried` row (a callback's `with` or `on_approved`) is storage only: it queues no model effect, write event or wake.
 */
export type Write = { model: string; id: string; erased?: boolean; carried?: true } &
	/** `revision`: a deleted row re-created by an approval rollback at its next revision; its values are stored columns, no `seq` is drawn. */
	(
		| { op: 'create'; values: RowData; revision?: number }
		| { op: 'update'; set: RowData; revision: number }
		| { op: 'delete'; revision: number }
	);
export type RateCharge = { rule: string; bucket: string; limit: number; windowStart: string };
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
	rate: readonly RateCharge[];
	runs: readonly (QueuedRun & { id: string; actor?: string; starter?: Json })[];
	/** An approval decision's notices; an act sends none. */
	notices?: readonly NoticeInsert[];
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
	/**
	 * A write its flow requires that joined the open request holding its records (no request opens): asserted at commit,
	 * so a request decided since the plan read it replays the act instead of committing the write unreviewed.
	 */
	joined?: true;
	/** A `keep` upsert creates rows: a unique clash means another writer created one first, and the act replays to keep it. */
	kept?: true;
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
	/**
	 * Per-record restores: each record's direct revision is recorded `restored` from `revision`. Only these rows are written
	 * in the native rules' `restore` mode; every other row of the statement keeps its rules.
	 */
	restored?: readonly { model: string; id: string; revision: number }[];
};
type Piece = { name: string; table: string; op: Write['op']; cascade: boolean };
/**
 * One statement of a commit split by `parts`: the first (`index` 0) opens the gate, the last answers for the whole
 * `act` and queues its effects and events over every statement's rows.
 */
export type Part = { readonly index: number; readonly last: boolean; readonly act: readonly Write[] };
/** What one statement of a large act holds at most: Neon runs each statement in bounded memory. */
const PART = { rows: 1_000, bytes: 1_048_576 };
/**
 * A large act as bounded statements of one transaction, or `undefined` for one statement. Only creates and updates
 * split: a table's rows follow those of every table it references (a parent before its children, so a reference and a
 * roll-up find their row), in input order. A delete, erasure, restore, approval, decision, notice or sync page stays one
 * statement: its pieces read every row at once.
 */
export function parts(m: EngineManifest, x: Commit): readonly Commit[] | undefined {
	if (x.writes.length <= PART.rows && utf8Bytes(JSON.stringify(x.writes)) <= PART.bytes) return undefined;
	if (
		x.writes.some((w) => w.op === 'delete' || w.erased === true) ||
		x.erase !== undefined || (x.erasures?.length ?? 0) > 0 || (x.restored?.length ?? 0) > 0 ||
		x.approval !== undefined || x.resubmit !== undefined || x.joined === true || x.before !== undefined ||
		x.approvalDecision !== undefined || x.rollback === true || (x.notices?.length ?? 0) > 0 || x.pieces !== undefined
	)
		return undefined;
	const written = new Set(x.writes.map((w) => w.model));
	const edges = relations(m).all.flatMap((r) =>
		written.has(r.from) ? r.targets.filter((to) => written.has(to)).map((to) => ({ from: r.from, to })) : []
	);
	// a table's rows may name each other: only one statement checks them together
	if (edges.some((edge) => edge.from === edge.to)) return undefined;
	const depth = new Map<string, number>();
	for (let moved = true, rounds = 0; moved; rounds++) {
		if (rounds > written.size) return undefined; // a cycle: no order puts every parent first
		moved = false;
		for (const { from, to } of edges)
			if ((depth.get(to) ?? 0) + 1 > (depth.get(from) ?? 0)) {
				depth.set(from, (depth.get(to) ?? 0) + 1);
				moved = true;
			}
	}
	const chunks: Write[][] = [];
	let rows = PART.rows,
		bytes = 0;
	for (const w of [...x.writes].sort((a, b) => (depth.get(a.model) ?? 0) - (depth.get(b.model) ?? 0))) {
		const size = utf8Bytes(JSON.stringify(w));
		if (rows >= PART.rows || (rows > 0 && bytes + size > PART.bytes)) {
			chunks.push([]);
			rows = 0;
			bytes = 0;
		}
		chunks.at(-1)?.push(w);
		rows++;
		bytes += size;
	}
	return chunks.length < 2 ? undefined : chunks.map((writes) => ({ ...x, writes }));
}

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
type Group = { table: string; op: Write['op']; erased: boolean; carried: boolean; first: Write; columns: readonly string[]; g: number };
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
	audit?: AuditMutation,
	part?: Part
): Effect.fn.Return<Sql, BoltError> {
	const c = new Chain();
	const first = (part?.index ?? 0) === 0,
		last = part === undefined || part.last;
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
		store: `jsonb_build_object('mode', ${(x.restored?.length ?? 0) > 0 ? `'restore', 'rows', ${c.p((x.restored ?? []).map((r) => `${r.model}/${r.id}`))}::jsonb` : "'write'"}, 'actor', ${byText}, 'at', ${now})`,
		...(anonymised.length === 0 ? {} : { anonymise: anonymised.join(' || ') }),
		...(part === undefined ? {} : { part: first ? ('first' as const) : ('later' as const) })
	});
	// built only when used: an unused parameter has no type PostgreSQL can determine
	const operation = () => audit === undefined ? 'NULL::text' : `${c.shared('operation', audit.event.operation_id)}::text`;
	// the act-wide pieces are the first statement's; a later one carries rows and what they queue
	if (first) {
		rate(c, x.rate);
		x.before?.(c);
		fingerprintAsserts(c, [...(x.fingerprints ?? []), ...(x.readGuards?.fingerprints ?? [])]);
		if (x.readGuards?.inconsistent === true) c.assert('false', 'fingerprint');
	}
	if (audit !== undefined && first) {
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
		const carried = w.carried === true;
		const key = [w.model, w.op, erased, carried, ...Object.keys(row).sort()].join('\0');
		const group = groups.get(key) ?? { table: w.model, op: w.op, erased, carried, first: w, columns: Object.keys(row), g: groups.size };
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

	// locks, state moves and an owned child's locked parent are the native rules' (store `rules.ts`), raised at commit
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
	AND t.id = r.id AND t.revision = r.revision AND ${GATED}${previousDelete === undefined ? '' : ` AND (SELECT count(*) FROM ${previousDelete}) >= 0`}
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
	FROM ${inGroup(group)} AND ${GATED} ${RETURNING(table, 'create', cause(group), String(group.erased))}`
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
	FROM ${inGroup(group)} AND t.id = r.id AND t.revision = r.revision AND ${GATED} ${RETURNING(table, 'update', cause(group), String(group.erased))}`,
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
	if (x.joined === true && hit !== null) c.assert('EXISTS (SELECT 1 FROM ap_hit)', 'fingerprint');
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
		history_piece(c, 'history_source', { restored: x.restored ?? [], request: request(), operation: operation(), uuid: true });
	}
	x.approval?.pieces(c, hit);
	x.resubmit?.pieces(c, hit);
	if (erasures.length > 0 && hasWrites) erasePieces(c, erasures, audit === undefined ? null : operation());
	c.cte('effectp', 'SELECT * FROM allp WHERE NOT erased');
	// carried rows are storage only: no model effect, write event or wake (they still reach live readers and syncs)
	const carried = [...groups.values()].filter((group) => group.carried);
	const own = carried.length === 0
		? 'effectp'
		: c.cte('ownp', `SELECT * FROM effectp x WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.j->>'id' = x.id AND (${carried
			.map((group) => `(i.g = ${group.g} AND x.c = ${literal(group.table)})`).join(' OR ')}))`);
	if (x.rollback !== true && x.approvalDecision?.stands !== false) {
		const requests = [
			...(hit === null ? [] : [`SELECT id,records FROM ${hit}`]),
			...(x.approval === undefined ? [] : ['SELECT id,records FROM ap_state'])
		];
		queue_effects(m, c, x.now, x.writer, own, x.key, requests.length === 0 ? null : c.cte('effect_requests', requests.join(' UNION ALL ')),
			part === undefined ? undefined : { index: part.index, last: part.last });
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
	if (first && x.runs.length > 0) enqueue(c, x.runs, { when: GATED, conflict: 'replace' });
	if ((x.notices?.length ?? 0) > 0) noticeInsert(c, 'notices', x.notices ?? [], x.now, GATED, m.teams, m.workspace.signup?.policies);
	x.pieces?.(c); // hook:syncs

	// in the act's own order (the input's; `records[0]` is what was written), anything else after by model and id; a
	// split act's last statement reads the earlier statements' rows back, at the revision a later roll-up left them
	const outcome = () => {
		const records = part === undefined
			? `(SELECT coalesce(jsonb_agg(jsonb_build_object('model', x.c, 'id', x.id, 'revision', x.revision) ORDER BY i.ord NULLS LAST, x.c, x.id), '[]'::jsonb)
		FROM allp x LEFT JOIN input i ON i.j->>'id' = x.id WHERE x.cause IN ('direct', 'erased'))`
			: `(SELECT coalesce(jsonb_agg(jsonb_build_object('model', w.c, 'id', w.id, 'revision', coalesce(a.revision, CASE w.c ${[...new Set(part.act.map((w) => w.model))]
					.map((table) => `WHEN ${literal(table)} THEN (SELECT t.revision FROM ${q(table)} t WHERE t.id = w.id::${cat.models.get(table)?.fields.get('id')?.pg ?? 'text'})`)
					.join(' ')} END)) ORDER BY w.ord), '[]'::jsonb)
		FROM (SELECT e.j->>0 AS c, e.j->>1 AS id, e.ord FROM jsonb_array_elements(${c.p(part.act.map((w) => [w.model, w.id]))}::jsonb) WITH ORDINALITY AS e(j, ord)) w
		LEFT JOIN (SELECT c, id, max(revision) AS revision FROM allp GROUP BY c, id) a ON a.c = w.c AND a.id = w.id)`;
		const commitOutcome = () =>
			`jsonb_build_object('kind', 'committed', 'output', ${c.p(JSON.stringify(x.output))}::jsonb, 'records', ${records}${x.unchanged === undefined ? '' : `, 'unchanged', ${c.p(JSON.stringify(x.unchanged))}::jsonb`})`;
		return x.resubmit?.pending === true
				? `jsonb_build_object('kind', 'pending_approval', 'request_id', ${c.p(x.resubmit.request)}::text, 'records', ${records})`
				: x.approval === undefined
					? commitOutcome()
					: `CASE WHEN ${hit === null ? 'false' : `EXISTS (SELECT 1 FROM ${hit})`} THEN ${commitOutcome()}
		ELSE jsonb_build_object('kind', 'pending_approval', 'request_id', ${c.p(x.approval.request_id)}::text, 'records', ${records}) END`;
	};
	const result = last ? answer(c, x.key, x.digest, outcome()) : 'NULL::jsonb AS outcome';
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
	erase: boolean,
	/** A split commit's earlier statements (`parts`), sent before `compile`'s in the same transaction. */
	earlier: (audit: AuditMutation | undefined) => Effect.Effect<readonly Sql[], BoltError> = () => Effect.succeed([])
) {
	const audit = yield* AuditMutation;
	const before = yield* earlier(audit);
	const statement = yield* compile(audit);
	const sent = batch(statement);
	const results = yield* db
		.transaction({ ...sent, statements: [...before, ...sent.statements] })
		.pipe(Effect.provideService(AuditMutation, undefined));
	const decoded = yield* Effect.forEach(results.slice(0, before.length + 1), (result) =>
		Schema.decodeUnknownEffect(Schema.Array(CommitAnswer))(result.rows).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'commit', error.message, error))
		)
	);
	const parts = decoded.map((rows) => rows[0]),
		last = parts.at(-1);
	// the last statement answers; every statement's rows are captured, queued and audited
	const answers: readonly CommitAnswer[] =
		before.length === 0 || last === undefined
			? (decoded[0] ?? [])
			: [
					{
						...last,
						captured: parts.flatMap((part) => part?.captured ?? []),
						next_due:
							parts
								.flatMap((part) => (part === undefined || part.next_due === null ? [] : [part.next_due]))
								.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
						changed_instances: [...new Set(parts.flatMap((part) => part?.changed_instances ?? []))],
						...(last.audited === undefined
							? {}
							: { audited: { ...last.audited, records: parts.flatMap((part) => part?.audited?.records ?? []) } })
					}
				];
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
	const split = parts(manifest, commit) ?? [commit];
	const part = (index: number): Part | undefined =>
		split.length === 1 ? undefined : { index, last: index === split.length - 1, act: commit.writes };
	const answers = yield* runCommit(
		db,
		(audit) => compileCommit(manifest, catalog, split.at(-1) ?? commit, audit, part(split.length - 1)),
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
		(commit.erasures?.length ?? 0) > 0 || commit.erase !== undefined,
		// a split act parks its earlier statements' rows for the last one's effects and events
		(audit) =>
			split.length === 1
				? Effect.succeed([])
				: Effect.map(
						Effect.forEach(split.slice(0, -1), (x, index) => compileCommit(manifest, catalog, x, audit, part(index))),
						(parts) => [{ text: PARTS_TABLE, params: [] }, ...parts]
					)
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
