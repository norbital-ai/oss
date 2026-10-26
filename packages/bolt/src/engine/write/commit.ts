// A native atomic batch: guarded direct writes, database referential actions and row history, then complete captured
// effects for approvals, roll-ups, queued runs, notices, the sync outbox and the receipt.
import type { Json } from '../../decl/values.ts';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import { BoltError, storeSync } from '../../protocol/errors.ts';
import { SqlSessionDb, type TenantDbShape } from '../db/tenant-db.ts';
import { readGuardBaseline } from '../approvals/read-guards.ts';
import { Context, Effect, Schema } from 'effect';
import type { EngineError } from '../errors.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import type {
	Captured,
	EngineActor,
	Lock,
	NoticeRow,
	Outcome,
	QueuedRun,
	RowData,
	Sql
} from '../contracts.ts';
import { relations, type EngineManifest } from '../manifest.ts';
import { Live, Wake, Links } from '../services.ts';
import { toPred } from '../access/pred.ts';
import { q, cells, nullRowSql, ownPredSql, type Catalog, type FieldInfo } from '@norbital-ai/store';
import { enqueue, nextDue, queueTriggered } from '../runs/queue.ts'; // hook:automations
import { syncOutboxPiece } from '../sync/write.ts'; // hook:syncs (H3)
import { purgeProposals } from '../approvals/erase.ts';
import {
	answer,
	Chain,
	fingerprintAsserts,
	GATED,
	gate,
	noticeCaptures,
	noticeInsert,
	rate,
	type Fingerprint,
	type ReadGuards
} from './sql.ts';
import { lockPieces } from '../approvals/lock.ts';
import { captureFinish, captureStart, netRows } from './capture.ts';

/** One row change as the statement writes it: upserts are already resolved, updates carry the stored revision. */
export type Write = { collection: string; id: string; erased?: boolean } &
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
	field: string;
	ids: readonly string[];
	states: readonly string[];
};
export type Commit = {
	key: string;
	digest: string;
	issuedAt: string;
	now: string;
	today: string;
	actor: EngineActor;
	writes: readonly Write[];
	owned: readonly OwnedLock[];
	rate: readonly RateCharge[];
	runs: readonly (QueuedRun & { id: string; actor?: string; starter?: Json })[];
	notices: readonly (NoticeRow & { id: string })[];
	output: Json;
	/**
	 * A routed write commits at once (provisional) and opens a request: its pieces follow the domain pieces and read
	 * `allp` for the checkpoint. `route` is the flow snapshot the approval callback returned (one per statement). When an
	 * open request already holds a touched row (`held`, the lock's CTE) the write joins it: no request opens and the
	 * outcome commits.
	 */
	approval?: {
		requestId: string;
		route: Extract<ApprovalSnapshot, { kind: 'steps' }>;
		pieces: (c: Chain, held: string | null) => void;
	};
	/** A requester's save on their own ChangesRequested request (`ApprovalHook.resubmit`): pieces after `allp` and the lock. */
	resubmit?: { request: string; pending: boolean; pieces: (c: Chain) => void };
	/** An approval decision's own statement: authorized in `before`, exempt from the lock, its history linked to `request`. */
	before?: (c: Chain) => void;
	approvalDecision?: { request: string };
	/** An engine sync rollback restores its checkpoint without taking an approval lock or resending it. */
	rollback?: true;
	/** hook:syncs — pieces after `allp` (a sync read page's cursor, id map and version stamps). */
	pieces?: (c: Chain) => void;
	/** Rule 26: the write callbacks' reads, re-digested under the table lock and asserted before the statement commits. */
	fingerprints?: readonly Fingerprint[];
	/** Native prior automation query intent, fixed across retries and persisted for held approvals. */
	readGuards?: ReadGuards;
	/** Native interactive stages defer their approval and effect publication to the outer receipt. */
	transactionStage?: true;
	/**
	 * Rule 38e: the direct pieces are `erased` revisions. Remove drops every revision of every deleted row; anonymise
	 * drops `purge` fields from the targets' earlier revisions (a revision left empty goes). Durable audit defers the
	 * history purge until complete external acknowledgement. Both drop notices linking a deleted row.
	 */
	erase?:
		| { mode: 'remove' }
		| { mode: 'anonymise'; collection: string; ids: readonly string[]; purge: readonly string[] };
	/** Recorded actions may contain several independent erasures alongside ordinary writes. */
	erasures?: readonly NonNullable<Commit['erase']>[];
	/** Per-record restores: each record's direct revision is recorded `restored` from `revision`. */
	restored?: readonly { collection: string; id: string; revision: number }[];
};
type Piece = { name: string; table: string };

/** `created_by`/`updated_by`: a member's id, or an envoy turn's linked sender (hook:envoys, P32); other actors are recorded in history only. */
export const actorId = (a: EngineActor): string | null =>
	a.kind === 'member' ? a.id : a.kind === 'envoy' ? a.member : null;
/** History's actor (rule 17): `<kind>:<id>`. */
export const actorRef = (a: EngineActor): string =>
	`${a.kind}:${a.kind === 'member' ? a.id : a.kind === 'system' ? a.run : a.kind === 'apiKey' ? a.key : a.kind === 'visitor' ? a.visitor : a.sender}`;

const RETURNING = (
	table: string,
	op: string,
	cause: string,
	erased = 'false'
) => `RETURNING ${`'${table}'`}::text AS c, coalesce(new.id, old.id)::text AS id,
	coalesce(new.revision, old.revision + 1)::int AS revision, '${op}'::text AS op, ${cause}::text AS cause, ${erased} AS erased,
	CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o, CASE WHEN new.id IS NULL THEN NULL ELSE to_jsonb(new) END AS n`;
const union = (pieces: readonly Piece[]) =>
	pieces
		.map((p) => `SELECT c, id, revision, op, cause, erased, o, n FROM ${p.name}`)
		.join(' UNION ALL ');

/** Roll-up fields of `model`: `{ kind: 'sum', of: 'lines.amount' }` / `{ kind: 'count', of: 'lines' }` with their `where`. */
export function rollups(m: EngineManifest, cat: Catalog, model: string) {
	return Object.entries(m.models[model]?.fields ?? {}).flatMap(([field, k]) => {
		if (k.kind !== 'sum' && k.kind !== 'count') return [];
		const [relName, childField] = k.of.split('.') as [string, string | undefined];
		const rel = cat.models.get(model)!.many.get(relName)!;
		return [
			{
				field,
				kind: k.kind,
				child: rel.child,
				fk: rel.column,
				childField,
				where: k.where === undefined ? undefined : toPred(m, rel.child, k.where)
			}
		];
	});
}

/** A `seq` pattern's text around its counter, the period tokens resolved (`'PO-{yyyy}-{0000}'` → `PO-2026-`, 4, ``). */
export function seqParts(
	pattern: string | undefined,
	date: { yyyy: string; mm: string }
): { pre: string; width: number; post: string } {
	const dated = (pattern ?? '{0}')
		.replaceAll('{yyyy}', date.yyyy)
		.replaceAll('{yy}', date.yyyy.slice(2))
		.replaceAll('{mm}', date.mm);
	const counter = /\{(0+)\}/.exec(dated);
	return counter === null
		? { pre: dated, width: 1, post: '' }
		: {
				pre: dated.slice(0, counter.index),
				width: counter[1]!.length,
				post: dated.slice(counter.index + counter[0].length)
			};
}
/** A counter's scope in `bolt_seq`: the pattern period and the `per` values. */
export const seqScope = (pre: string, post: string, per: readonly Json[]): string =>
	JSON.stringify([pre, post, ...per]);
const sequenceKey = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String]))
);
/** `seq` meta per created row (host side): the counter key per pattern period and `per` scope, and the row's place in it. */
function seqMeta(m: EngineManifest, writes: readonly Write[], today: string) {
	const counts = new Map<string, number>();
	const plan: {
		w: Write & { op: 'create' };
		field: string;
		key: string;
		index: number;
		pre: string;
		width: number;
		post: string;
		text: boolean;
	}[] = [];
	for (const w of writes) {
		if (w.op !== 'create' || w.revision !== undefined) continue;
		for (const [field, k] of Object.entries(m.models[w.collection]?.fields ?? {})) {
			if (k.kind !== 'seq') continue;
			const { pre, width, post } = seqParts(k.pattern, {
				yyyy: today.slice(0, 4),
				mm: today.slice(5, 7)
			});
			const scope = seqScope(
				pre,
				post,
				(k.per ?? []).map((p) => w.values[p] ?? null)
			);
			const key = JSON.stringify([w.collection, field, scope]);
			const index = counts.get(key) ?? 0;
			counts.set(key, index + 1);
			plan.push({ w, field, key, index, pre, width, post, text: k.pattern !== undefined });
		}
	}
	return { counts, plan };
}

export function compileCommit(m: EngineManifest, cat: Catalog, x: Commit): readonly Sql[] {
	let c = new Chain();
	const token = JSON.stringify([x.key, x.digest]);
	const audited = new Set(
		Object.entries(m.models).flatMap(([name, model]) => (model.table === undefined ? [name] : []))
	);
	gate(c, x.key, x.digest, x.issuedAt);
	rate(c, x.rate);
	x.before?.(c);
	fingerprintAsserts(c, [...(x.fingerprints ?? []), ...(x.readGuards?.fingerprints ?? [])]);
	if (x.readGuards?.inconsistent === true) c.assert('false', 'fingerprint');
	const erasures = x.erasures ?? (x.erase === undefined ? [] : [x.erase]);
	const erasedTargets = x.writes
		.filter((write) => write.erased ?? x.erase !== undefined)
		.map((write) => `${write.collection}/${write.id}`);
	const erasedKeys = erasedTargets.length === 0 ? undefined : c.p(erasedTargets);
	const erased = (table: string, id: string) =>
		erasedKeys === undefined
			? 'false'
			: `${erasedKeys}::jsonb ? (${c.p(table)}::text || '/' || ${id}::text)`;
	const direct = (table: string) =>
		`CASE WHEN ${erased(table, 'coalesce(new.id, old.id)')} THEN 'erased' ELSE 'direct' END`;
	const by = actorId(x.actor);
	// a system table carries only the engine columns it declares (sys_integration its `revision`)
	const system = (op: 'create' | 'update', fields: ReadonlyMap<string, unknown>) =>
		Object.fromEntries(
			Object.entries({
				updated_at: x.now,
				updated_by: by,
				...(op === 'create' ? { revision: 1, created_at: x.now, created_by: by } : {})
			}).filter(([k]) => fields.has(k))
		);

	// seq counters: one piece for every key the act draws from
	const seq = seqMeta(m, x.writes, x.today);
	const meta = new Map<Write, Record<string, Json>>();
	for (const s of seq.plan) {
		const back = seq.counts.get(s.key)! - 1 - s.index;
		meta.set(s.w, {
			...meta.get(s.w),
			[s.field]: [sequenceKey(s.key), back, s.pre, s.width, s.post, s.text]
		});
	}
	// `bolt_seq (model, field, scope, value)` is the schema area's; `key` is the three as a JSON array
	if (seq.counts.size > 0)
		c.cte(
			'seq',
			`INSERT INTO bolt_seq (model, field, scope, value)
	SELECT v.k->>0, v.k->>1, v.k->>2, v.c FROM jsonb_to_recordset(${c.p([...seq.counts].map(([key, n]) => ({ k: sequenceKey(key), c: n })))}::jsonb) AS v(k jsonb, c int)
	WHERE ${GATED} ON CONFLICT (model, field, scope) DO UPDATE SET value = bolt_seq.value + excluded.value
	RETURNING jsonb_build_array(model, field, scope) AS key, value AS n`
		);

	// rule 41: an owned child's direct write holds its parent in an admitting state. The child piece reads the assert, so
	// the parent's `FOR SHARE` is taken before any piece of this statement changes that parent (a row the statement
	// already changed would be skipped by `FOR SHARE`, not re-tested)
	const held = new Map<string, string>();
	for (const o of x.owned) {
		const a = c.assert(
			`(SELECT count(*) FROM (SELECT 1 FROM ${q(o.parent)} WHERE id::text IN (SELECT jsonb_array_elements_text(${c.p(o.ids)}::jsonb))
	AND ${q(o.field)}::text IN (SELECT jsonb_array_elements_text(${c.p(o.states)}::jsonb)) FOR SHARE) s) = ${o.ids.length}`,
			'locked'
		);
		held.set(
			o.child,
			`${held.has(o.child) ? `${held.get(o.child)} AND ` : ''}EXISTS (SELECT 1 FROM ${a})`
		);
	}
	const guard = (table: string) => (held.has(table) ? `${GATED} AND ${held.get(table)}` : GATED);
	let pieces: Piece[] = [];
	const on = (table: string) => pieces.filter((p) => p.table === table);
	let n = 0;
	const add = (
		table: string,
		sql: string,
		count?: { rows: number; ids: readonly string[] }
	): string => {
		const name = c.cte(`p${n++}`, sql);
		pieces.push({ name, table });
		if (count !== undefined)
			c.assert(
				`(SELECT count(*) FROM ${name}) = ${count.rows}`,
				'conflict',
				JSON.stringify({ collection: table, ids: count.ids })
			);
		return name;
	};
	const byTable = Map.groupBy(x.writes, (w) => w.collection);

	// Referential actions belong to the foreign keys. Their actual row changes enter the native capture buffer.
	const deleteOrder: string[] = [];
	const deleteTables = new Set(
		x.writes.filter((write) => write.op === 'delete').map((write) => write.collection)
	);
	const visitDelete = (table: string, seen: Set<string>) => {
		if (deleteOrder.includes(table) || seen.has(table)) return;
		seen.add(table);
		for (const relation of relations(m).all)
			if (relation.targets.includes(table) && deleteTables.has(relation.from))
				visitDelete(relation.from, seen);
		deleteOrder.push(table);
	};
	for (const table of deleteTables) visitDelete(table, new Set());
	let previousDelete: string | undefined;
	for (const table of deleteOrder) {
		const ws = byTable.get(table) ?? [];
		const rows = ws
			.filter((w) => w.op === 'delete')
			.map((w) => ({ id: w.id, revision: w.revision }));
		if (rows.length === 0) continue;
		previousDelete = add(
			table,
			`DELETE FROM ${q(table)} t USING jsonb_populate_recordset(${nullRowSql(table, cat.models.get(table)?.fields.keys() ?? [])}, ${c.p(rows)}::jsonb) r
	WHERE t.id = r.id AND t.revision = r.revision AND ${guard(table)} ${previousDelete === undefined ? '' : `AND (SELECT count(*) FROM ${previousDelete})>=0`} ${RETURNING(table, 'delete', direct(table), erased(table, 'coalesce(new.id, old.id)'))}`,
			{ rows: rows.length, ids: rows.map((r) => r.id) }
		);
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
	for (const t of new Set([
		...byTable.keys(),
		...pieces.map((p) => p.table),
		...Object.keys(m.models)
	]))
		visit(t, new Set());
	for (const table of order) {
		// roll-up deltas from every piece on the child so far, new minus old, each side under the roll-up's `where`
		const folds = rollups(m, cat, table).flatMap((r) => {
			const src = on(r.child);
			if (src.length === 0) return [];
			const side = (
				col: 'o' | 'n',
				sign: string
			) => `SELECT (s.row).${q(r.fk)} AS pid, ${sign}${r.kind === 'count' ? '1' : `coalesce((s.row).${q(r.childField!)}, 0)`} AS d, s.erased
		FROM (SELECT jsonb_populate_record(${nullRowSql(r.child, cat.models.get(r.child)?.fields.keys() ?? [])}, x.${col}) AS row, x.erased FROM (${union(src)}) x WHERE x.${col} IS NOT NULL) s
		WHERE ${r.where === undefined ? 'true' : storeSync(ownPredSql(r.where, 's.row', c))}`;
			const rd = c.cte(`rd${n++}`, `${side('o', '-')} UNION ALL ${side('n', '')}`);
			return [{ field: r.field, rd }];
		});
		const fold = (f: { field: string; rd: string }, base: string, id: string) =>
			`${base} + coalesce((SELECT sum(d) FROM ${f.rd} WHERE pid = ${id}), 0)`;
		const ws = byTable.get(table) ?? [];
		const fields = cat.models.get(table)?.fields ?? new Map<string, FieldInfo>();

		for (const shape of Map.groupBy(
			ws.filter((w) => w.op === 'create'),
			(w) => Object.keys(w.values).sort().join(',')
		).values()) {
			const rows = shape.map((w) => ({
				...Object.fromEntries(
					Object.entries(w.values).flatMap(([k, v]) => cells(k, v, fields.get(k)))
				),
				...system('create', fields),
				...(w.revision === undefined ? {} : { revision: w.revision }),
				id: w.id,
				$seq: meta.get(w) ?? {}
			}));
			const cols = [
				...new Set(['id', ...Object.keys(rows[0]!).filter((k) => k !== '$seq' && k !== 'id')])
			];
			const seqCols = Object.keys(rows[0]!.$seq);
			const seqExpr = (f: string) => {
				const at = (i: number) => `(e.j->'$seq'->'${f}'->>${i})`;
				const num = `((SELECT s.n FROM seq s WHERE s.key = (e.j->'$seq'->'${f}'->0)) - ${at(1)}::int)`;
				return `CASE WHEN ${at(5)}::boolean THEN ${at(2)} || CASE WHEN length(${num}::text) >= ${at(3)}::int THEN ${num}::text ELSE lpad(${num}::text, ${at(3)}::int, '0') END || ${at(4)} ELSE ${num}::text END`;
			};
			const all = [...cols, ...seqCols, ...folds.map((f) => f.field)];
			add(
				table,
				`INSERT INTO ${q(table)} (${all.map(q).join(', ')})
	SELECT ${[...cols.map((k) => `r.${q(k)}`), ...seqCols.map((f) => `(${seqExpr(f)})::${cat.models.get(table)!.fields.get(f)!.pg}`), ...folds.map((f) => fold(f, '0', 'r.id'))].join(', ')}
	FROM jsonb_array_elements(${c.p(rows)}::jsonb) e(j), jsonb_populate_record(${nullRowSql(table, cat.models.get(table)?.fields.keys() ?? [])}, e.j) r WHERE ${guard(table)} ${RETURNING(table, 'create', direct(table), erased(table, 'coalesce(new.id, old.id)'))}`
			);
		}
		for (const shape of Map.groupBy(
			ws.filter((w) => w.op === 'update'),
			(w) => Object.keys(w.set).sort().join(',')
		).values()) {
			const rows = shape.map((w) => ({
				...Object.fromEntries(
					Object.entries(w.set).flatMap(([k, v]) => cells(k, v, fields.get(k)))
				),
				...system('update', fields),
				id: w.id,
				revision: w.revision
			}));
			const sets = Object.keys(rows[0]!)
				.filter((k) => k !== 'id' && k !== 'revision')
				.map((k) => `${q(k)} = r.${q(k)}`);
			add(
				table,
				`UPDATE ${q(table)} t SET ${[...sets, ...folds.map((f) => `${q(f.field)} = ${fold(f, `t.${q(f.field)}`, 't.id')}`), 'revision = t.revision + 1'].join(', ')}
	FROM jsonb_populate_recordset(${nullRowSql(table, cat.models.get(table)?.fields.keys() ?? [])}, ${c.p(rows)}::jsonb) r WHERE t.id = r.id AND t.revision = r.revision AND ${guard(table)} ${RETURNING(table, 'update', direct(table), erased(table, 'coalesce(new.id, old.id)'))}`,
				{ rows: rows.length, ids: rows.map((r) => r.id) }
			);
		}
		// rows the act did not write whose roll-ups moved: one derived write each (rule 43), never twice in one statement
		if (folds.length > 0) {
			const mine = on(table)
				.map((p) => ` AND t.id::text NOT IN (SELECT id FROM ${p.name})`)
				.join('');
			const origins = `(${folds.map((f) => `SELECT pid, erased FROM ${f.rd}`).join(' UNION ALL ')})`;
			const erasedDerived = `EXISTS (SELECT 1 FROM ${origins} source WHERE source.pid = new.id AND source.erased)
				AND NOT EXISTS (SELECT 1 FROM ${origins} source WHERE source.pid = new.id AND NOT source.erased)`;
			add(
				table,
				`UPDATE ${q(table)} t SET ${[
					...folds.map((f) => `${q(f.field)} = ${fold(f, `t.${q(f.field)}`, 't.id')}`),
					'revision = t.revision + 1',
					`updated_at = ${c.p(x.now)}::timestamptz`
				].join(', ')}
	WHERE t.id IN (${folds.map((f) => `SELECT pid FROM ${f.rd} GROUP BY pid HAVING sum(d) <> 0`).join(' UNION ')})${mine} AND ${GATED} ${RETURNING(table, 'update', "'derived'", erasedDerived)}`
			);
		}
	}

	const hasWrites = pieces.length > 0;
	const origins = (source: readonly Piece[]) => {
		if (source.length === 0) return;
		c.cte(
			'native_origins',
			`INSERT INTO pg_temp.bolt_origins(token,c,id,revision,op,cause,erased)
			SELECT ${c.p(token)},c,id,revision,op,cause,erased FROM (${union(source)}) rows ON CONFLICT DO NOTHING RETURNING id`
		);
	};
	origins(pieces);
	const ordinary = pieces.filter((piece) => !audited.has(piece.table));
	if (ordinary.length > 0)
		c.cte(
			'native_system_changes',
			`INSERT INTO pg_temp.bolt_changes(token,c,id,revision,op,cause,erased,o,n)
			SELECT ${c.p(token)},c,id,revision,op,cause,erased,o,n FROM (${union(ordinary)}) rows RETURNING id`
		);
	// One row, one UPDATE: a decision records its authorization here, not in a second writer of the same temp row.
	c.cte(
		'native_fresh',
		`UPDATE pg_temp.bolt_write_context SET fresh=${GATED}${x.approvalDecision === undefined ? '' : ', authorized=(SELECT id FROM ap_authorize)'}
		WHERE token=${c.p(token)} RETURNING fresh`
	);
	const mutation = c.sql('(SELECT fresh FROM native_fresh) AS fresh');

	// A following command sees every native FK action and its row trigger's journal entry.
	c = new Chain();
	c.cte(
		'idem',
		`SELECT ${c.p(x.key)}::text AS key FROM pg_temp.bolt_write_context WHERE token=${c.p(token)} AND fresh`
	);
	if (x.approvalDecision !== undefined)
		c.cte(
			'ap_authorize',
			`SELECT authorized AS id FROM pg_temp.bolt_write_context WHERE token=${c.p(token)} AND fresh AND authorized IS NOT NULL`
		);
	c.cte('native_source', `SELECT * FROM pg_temp.bolt_changes WHERE token=${c.p(token)}`);
	pieces = [];
	for (const table of order) {
		const folds = rollups(m, cat, table).flatMap((r) => {
			const cascade = c.cte(
				`cascade${n++}`,
				`SELECT * FROM native_source WHERE c=${c.p(r.child)} AND cause='cascade'`
			);
			const sources = [{ name: cascade, table: r.child }, ...on(r.child)];
			const side = (
				image: 'o' | 'n',
				sign: string
			) => `SELECT (s.row).${q(r.fk)} AS pid,${sign}${r.kind === 'count' ? '1' : `coalesce((s.row).${q(r.childField!)},0)`} AS d,s.erased
				FROM (SELECT jsonb_populate_record(${nullRowSql(r.child, cat.models.get(r.child)?.fields.keys() ?? [])},x.${image}) AS row,x.erased FROM (${union(sources)}) x WHERE x.${image} IS NOT NULL) s
				WHERE ${r.where === undefined ? 'true' : storeSync(ownPredSql(r.where, 's.row', c))}`;
			const delta = c.cte(`native_delta${n++}`, `${side('o', '-')} UNION ALL ${side('n', '')}`);
			return [{ field: r.field, delta }];
		});
		if (folds.length === 0) continue;
		const sources = `(${folds.map((fold) => `SELECT pid,erased FROM ${fold.delta}`).join(' UNION ALL ')})`;
		add(
			table,
			`UPDATE ${q(table)} t SET ${[
				...folds.map(
					(fold) =>
						`${q(fold.field)}=t.${q(fold.field)}+coalesce((SELECT sum(d) FROM ${fold.delta} WHERE pid=t.id),0)`
				),
				'revision=t.revision+1',
				`updated_at=${c.p(x.now)}::timestamptz`
			].join(',')}
		WHERE t.id IN (${folds.map((fold) => `SELECT pid FROM ${fold.delta} GROUP BY pid HAVING sum(d)<>0`).join(' UNION ')}) AND ${GATED}
		${RETURNING(table, 'update', "'derived'", `EXISTS (SELECT 1 FROM ${sources} source WHERE source.pid=new.id AND source.erased) AND NOT EXISTS (SELECT 1 FROM ${sources} source WHERE source.pid=new.id AND NOT source.erased)`)}`
		);
	}
	origins(pieces);
	const systemDerived = pieces.filter((piece) => !audited.has(piece.table));
	if (systemDerived.length > 0)
		c.cte(
			'native_system_derived',
			`INSERT INTO pg_temp.bolt_changes(token,c,id,revision,op,cause,erased,o,n)
			SELECT ${c.p(token)},c,id,revision,op,cause,erased,o,n FROM (${union(systemDerived)}) rows RETURNING id`
		);
	c.cte(
		'row_events',
		`SELECT seq,c,id,revision,op,cause,erased,o,n FROM native_source${pieces.map((piece, index) => ` UNION ALL SELECT ${9000000000000000 + index}::bigint AS seq,c,id,revision,op,cause,erased,o,n FROM ${piece.name}`).join('')}`
	);
	c.cte('allp', netRows('row_events'));
	// the approval lock (lock.ts); a decision's own rollback is the request's, and a new request holds no row yet
	const hit =
		x.rollback !== true && hasWrites
			? lockPieces(m, cat, c, x.actor, 'allp', x.approvalDecision?.request)
			: null;
	if (x.approvalDecision !== undefined && hit !== null)
		c.assertWith(
			`NOT EXISTS (SELECT 1 FROM ${hit})`,
			'underApproval',
			`(SELECT id::text || ' An approval decision cannot change another held request.' FROM ${hit} LIMIT 1)`
		);
	if (x.transactionStage === true && hit !== null)
		c.assertWith(
			`NOT EXISTS (SELECT 1 FROM ${hit})`,
			'underApproval',
			`(SELECT id::text || ' An interactive transaction cannot edit an existing approval request.' FROM ${hit} LIMIT 1)`
		);
	const request =
		x.approval !== undefined
			? `coalesce((SELECT id FROM ${hit} LIMIT 1), ${c.p(x.approval.requestId)}::uuid)`
			: x.approvalDecision !== undefined
				? `${c.p(x.approvalDecision.request)}::uuid`
				: hit === null
					? 'NULL::uuid'
					: `(SELECT id FROM ${hit} LIMIT 1)`;
	if (hasWrites) {
		c.cte(
			'history_source',
			`SELECT allp.*, ${c.p(x.now)}::timestamptz AS at, ${c.p(actorRef(x.actor))}::text AS actor FROM allp
			WHERE NOT (c=ANY(ARRAY[${[...audited].map((table) => c.p(table)).join(',')}]::text[]))
			${erasures.some((spec) => spec.mode === 'remove') ? "AND (NOT erased OR op <> 'delete' OR cause = 'erased')" : ''}`
		);
		historyPiece(c, 'history_source', x.restored, request);
	}
	x.approval?.pieces(c, hit);
	x.resubmit?.pieces(c);
	if (erasures.length > 0 && hasWrites) erasePieces(c, erasures);
	c.cte('effectp', 'SELECT * FROM allp WHERE NOT erased');
	if (x.transactionStage !== true) queueTriggered(m, c, x.now, actorRef(x.actor), 'effectp'); // event runs exclude erased rows (rule 50)
	if (x.transactionStage !== true && x.approvalDecision === undefined && x.rollback !== true) {
		const notified = Object.entries(m.collections).filter(
			([model, spec]) => spec.notify === true && byTable.has(model)
		);
		if (notified.length > 0)
			enqueue(c, {
				select: notified
					.map(
						([model]) =>
							`SELECT 'bolt.notify'::text AS automation, jsonb_build_object('collection', ${c.p(model)}::text,
			'event', jsonb_build_object('kind', 'write', 'action', e.op, 'records', jsonb_agg(coalesce(e.n, e.o) ORDER BY e.id),
			'previous', jsonb_agg(e.o ORDER BY e.id), 'actor', ${c.p(x.actor)}::jsonb)) AS input,
			${c.p(x.now)}::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth
			FROM effectp e WHERE e.c = ${c.p(model)} AND e.cause = 'direct' GROUP BY e.op`
					)
					.join(' UNION ALL ')
			});
	}
	// a sync write is irreversible: a record an approval request holds queues only once it is approved (approvals.ts),
	// and a rollback restores a record without sending it again
	// (a routed write that joined an open request queues what that request does not hold; one that opened its own, nothing)
	if (
		x.transactionStage !== true &&
		x.approvalDecision === undefined &&
		x.rollback !== true &&
		(x.approval === undefined || hit !== null)
	)
		syncOutboxPiece(
			m,
			c,
			x.now,
			new Set(Object.keys(m.models)),
			x.actor,
			hit === null
				? 'effectp'
				: c.cte(
						'effect_free',
						`SELECT * FROM effectp x WHERE NOT EXISTS (SELECT 1 FROM ${hit} h CROSS JOIN LATERAL jsonb_array_elements(h.records) r
	WHERE r ->> 'collection' = x.c AND r ->> 'id' = x.id)${x.approval === undefined ? '' : ` AND EXISTS (SELECT 1 FROM ${hit})`}`
					)
		);
	if (x.transactionStage !== true && x.runs.length > 0)
		enqueue(c, x.runs, { when: GATED, conflict: 'replace' });
	if (x.transactionStage !== true && x.notices.length > 0)
		noticeInsert(c, 'notices', x.notices, x.now, GATED, m.teams, m.workspace.signup?.policies);
	x.pieces?.(c); // hook:syncs

	// in the act's own order (the input's; `records[0]` is what was written), anything else after by collection and id
	const at = c.p(Object.fromEntries(x.writes.map((w, i) => [`${w.collection}/${w.id}`, i])));
	const records = `(SELECT coalesce(jsonb_agg(jsonb_build_object('collection', c, 'id', id, 'revision', revision) ORDER BY (${at}::jsonb ->> (c || '/' || id))::int NULLS LAST, c, id), '[]'::jsonb) FROM allp WHERE cause IN ('direct', 'erased'))`;
	const commitOutcome = () =>
		`jsonb_build_object('kind', 'committed', 'output', ${c.p(JSON.stringify(x.output))}::jsonb, 'records', ${records})`;
	const outcome =
		x.resubmit?.pending === true
			? `jsonb_build_object('kind', 'pendingApproval', 'requestId', ${c.p(x.resubmit.request)}::text, 'records', ${records})`
			: x.approval === undefined
				? commitOutcome()
				: `CASE WHEN ${hit === null ? 'false' : `EXISTS (SELECT 1 FROM ${hit})`} THEN ${commitOutcome()}
		ELSE jsonb_build_object('kind', 'pendingApproval', 'requestId', ${c.p(x.approval.requestId)}::text, 'records', ${records}) END`;
	const result = answer(c, x.key, x.digest, outcome);
	const tables = affectedTables(m, cat, x.writes);
	c.cte(
		'native_result',
		`SELECT ${result}, (SELECT coalesce(jsonb_agg(jsonb_build_object('collection', c, 'id', id, 'op', op, 'revision', revision,
		'old', ${numericText(cat, tables, 'o')}, 'new', ${numericText(cat, tables, 'n')}, 'cause', cause)), '[]'::jsonb) FROM allp) || ${noticeCaptures(c)} AS captured, ${nextDue(c)} AS next_due,
		(SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM allp WHERE c = 'sys_integration'
		AND (o IS NULL OR n IS NULL OR (o->'configuration', o->'active', o->'integration', o->'envoy', o->'import_start')
		IS DISTINCT FROM (n->'configuration', n->'active', n->'integration', n->'envoy', n->'import_start'))) AS changed_instances, ${x.readGuards === undefined ? 'false' : 'EXISTS (SELECT 1 FROM idem)'} AS read_guards_applied${x.approvalDecision !== undefined ? ', (SELECT count(*) FROM up)::int AS approval_decided' : ''}`
	);
	c.cte(
		'native_saved',
		`UPDATE pg_temp.bolt_write_context context SET answer=to_jsonb(result),request=${request}
		FROM native_result result WHERE context.token=${c.p(token)} RETURNING context.answer`
	);
	return [
		...captureStart(
			{
				token,
				now: x.now,
				actor: actorRef(x.actor),
				direct: x.writes.map((write) => `${write.collection}/${write.id}`),
				erased: erasedTargets,
				mode: (x.restored?.length ?? 0) > 0 ? 'restore' : 'write',
				...(x.approvalDecision === undefined ? {} : { request: x.approvalDecision.request }),
				...(x.restored === undefined
					? {}
					: {
							restored: Object.fromEntries(
								x.restored.map((row) => [`${row.collection}/${row.id}`, row.revision])
							)
						})
			},
			by,
			Object.fromEntries(
				erasures.flatMap((spec) =>
					spec.mode === 'anonymise'
						? spec.ids.map((id) => [`${spec.collection}/${id}`, spec.purge] as const)
						: []
				)
			)
		),
		mutation,
		c.sql('(SELECT answer FROM native_saved) AS result'),
		captureFinish(token, x.approvalDecision !== undefined)
	];
}

/** The native action closure also bounds numeric decoding and locks before any domain mutation. */
export function affectedTables(
	m: EngineManifest,
	cat: Catalog,
	writes: readonly Write[]
): string[] {
	const affected = new Set(writes.map((write) => write.collection));
	const deleted = new Set(
		writes.filter((write) => write.op === 'delete').map((write) => write.collection)
	);
	for (let changed = true; changed;) {
		changed = false;
		for (const relation of relations(m).all) {
			if (!relation.targets.some((target) => deleted.has(target))) continue;
			const action =
				relation.spec.onDelete ?? (relation.spec.owned === true ? 'cascade' : 'restrict');
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
 * Rule 65: the captured image's stored `numeric` columns (decimal, money, sum) as text, so a live delta keeps their scale
 * (`1.20`; a parsed JSON number is 1.2) and patches them without a read. History and the triggers compare old with new,
 * which stay alike; `holds3` and `eval` compare a numeric text as a number.
 */
function numericText(cat: Catalog, tables: readonly string[], x: string): string {
	const arms = tables.flatMap((t) => {
		const cols = [...(cat.models.get(t)?.fields.values() ?? [])]
			.filter((f) => f.pg === 'numeric' && f.computed !== true)
			.map((f) => `'${f.column}', ${x}->>'${f.column}'`);
		// jsonb_build_object takes at most 100 arguments
		const objects = Array.from(
			{ length: Math.ceil(cols.length / 50) },
			(_, i) => `jsonb_build_object(${cols.slice(i * 50, i * 50 + 50).join(', ')})`
		);
		return objects.length === 0 ? [] : [`WHEN c = '${t}' THEN ${x} || ${objects.join(' || ')}`];
	});
	return arms.length === 0 ? x : `CASE WHEN ${x} IS NULL THEN NULL ${arms.join(' ')} ELSE ${x} END`;
}

/**
 * The outcome record (rule 20): a refusal or conflict decided after guest code or inside Postgres, recorded with the
 * rate increment so a replay answers it without re-running guest code, and so refused attempts count.
 */
export function compileOutcomeRecord(
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
const UNHISTORIED = `ARRAY['bolt_search', 'bolt_embedding']`;
/** Rule 38e(a–c): purge prior history and notices while retaining the direct erasure's own receipt. */
function erasePieces(c: Chain, erasures: readonly NonNullable<Commit['erase']>[]): void {
	const operation = "nullif(current_setting('bolt.audit',true),'')";
	// Durable audit must capture the erase's own before image before its history can disappear.
	const immediate = `${operation} IS NULL`;
	// A request holding an erased row goes with it: its log names the record and may quote it.
	for (const [name, sql] of Object.entries(
		purgeProposals(
			`${GATED} AND EXISTS (
		SELECT 1 FROM allp x WHERE x.erased AND (x.op = 'delete' OR x.cause = 'erased') AND (
			(a.collection = x.c AND a.record = x.id)
			OR a.records @> jsonb_build_array(jsonb_build_object('collection', x.c, 'id', x.id))))`,
			`${GATED} AND EXISTS (SELECT 1 FROM allp x WHERE x.erased AND x.op = 'delete' AND n.link ->> 'collection' = x.c AND n.link ->> 'id' = x.id)`
		)
	))
		c.cte(name, sql);
	if (erasures.some((e) => e.mode === 'remove')) {
		c.cte(
			'defer_removed',
			`INSERT INTO bolt_audit_erase(operation,collection,record,revision,mode,keep_marker)
			SELECT ${operation},x.c,x.id::uuid,x.revision,'remove',x.cause='erased'
			FROM allp x WHERE x.erased AND x.op='delete' AND x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			AND ${operation} IS NOT NULL AND ${GATED}
			ON CONFLICT DO NOTHING RETURNING record`
		);
		c.cte(
			'purge_removed',
			`DELETE FROM bolt_history h USING allp x WHERE x.erased AND x.op = 'delete' AND h.collection = x.c AND h.record::text = x.id
			AND NOT (x.cause='erased' AND h.revision=x.revision) AND ${immediate} AND ${GATED}`
		);
	}
	for (const [index, e] of erasures.entries()) {
		if (e.mode === 'remove') continue;
		const fields = `ARRAY(SELECT jsonb_array_elements_text(${c.p(e.purge)}::jsonb))`;
		const at = `h.collection = ${c.p(e.collection)} AND h.record::text IN (SELECT jsonb_array_elements_text(${c.p(e.ids)}::jsonb)) AND h.changes ?| ${fields}
		AND h.revision < (SELECT min(x.revision) FROM allp x WHERE x.c=h.collection AND x.id=h.record::text)`;
		c.cte(
			`defer_anonymised${index}`,
			`INSERT INTO bolt_audit_erase(operation,collection,record,revision,mode,purge,keep_marker)
			SELECT ${operation},x.c,x.id::uuid,x.revision,'anonymise',${fields},true FROM allp x
			WHERE x.c=${c.p(e.collection)} AND x.id IN (SELECT jsonb_array_elements_text(${c.p(e.ids)}::jsonb))
			AND x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			AND ${operation} IS NOT NULL AND ${GATED} ON CONFLICT DO NOTHING RETURNING record`
		);
		c.cte(
			`purge${index}`,
			`UPDATE bolt_history h SET changes = h.changes - ${fields} WHERE ${at} AND (h.changes - ${fields} <> '{}'::jsonb OR h.cause='erased') AND ${immediate} AND ${GATED}`
		);
		c.cte(
			`purge_empty${index}`,
			`DELETE FROM bolt_history h WHERE ${at} AND h.cause<>'erased' AND h.changes - ${fields} = '{}'::jsonb AND ${immediate} AND ${GATED}`
		);
	}
}

/** Persist the authored revision from an identified source's row images; a restore marks its records' direct revisions. */
export function historyPiece(
	c: Chain,
	source: string,
	restored: Commit['restored'] = [],
	request = 'NULL::uuid'
): void {
	const marks =
		restored.length === 0
			? null
			: c.p(Object.fromEntries(restored.map((r) => [`${r.collection}/${r.id}`, r.revision])));
	const mark =
		marks === null ? 'false' : `(x.cause = 'direct' AND ${marks}::jsonb ? (x.c || '/' || x.id))`;
	const from = marks === null ? 'NULL::int' : `(${marks}::jsonb ->> (x.c || '/' || x.id))::int`;
	c.cte(
		`history_${source}`,
		`INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, changes, restored_from, request, operation, meta)
	SELECT x.c, x.id::uuid, x.revision, x.at, x.actor, x.op, CASE WHEN ${mark} THEN 'restored' ELSE x.cause END,
		CASE WHEN x.op='create' OR (x.erased AND x.op='update') THEN x.n - ${UNHISTORIED} WHEN x.op='delete' THEN '{}'::jsonb
		ELSE (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(x.n) AS e(k, v)
			WHERE k NOT IN ('revision', 'updated_at', 'updated_by') AND k <> ALL (${UNHISTORIED}) AND x.o->k IS DISTINCT FROM v) END,
		CASE WHEN ${mark} THEN ${from} END, ${request}, nullif(current_setting('bolt.audit',true),''),
		jsonb_build_object('id',x.id,'revision',coalesce(x.n,x.o)->'revision','updated_at',coalesce(x.n,x.o)->'updated_at','updated_by',coalesce(x.n,x.o)->'updated_by','created_at',coalesce(x.n,x.o)->'created_at','created_by',coalesce(x.n,x.o)->'created_by')
	FROM ${source} x WHERE x.id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`
	);
}
export const CommitAnswer = Schema.Struct({
	outcome: Schema.NullOr(WriteOutcome),
	captured: Schema.Array(
		Schema.Struct({
			collection: Schema.String,
			id: Schema.String,
			op: Schema.Literals(['create', 'update', 'delete']),
			revision: Schema.Number,
			old: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
			new: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
			cause: Schema.Literals(['direct', 'cascade', 'derived', 'erased'])
		})
	),
	next_due: Schema.NullOr(Schema.String),
	changed_instances: Schema.Array(Schema.String),
	approval_decided: Schema.optionalKey(Schema.Number),
	read_guards_applied: Schema.optionalKey(Schema.Boolean)
});
export type CommitAnswer = typeof CommitAnswer.Type;
export type CommitPublisher = (
	answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>,
	outcome?: Outcome
) => Effect.Effect<number>;
/** Native orchestration only: stages remain ordinary guarded writes on the leased connection. */
export type CommitStageShape = {
	execute: (
		db: TenantDbShape,
		manifest: EngineManifest,
		catalog: Catalog,
		commit: Commit,
		lock?: Lock
	) => Effect.Effect<readonly CommitAnswer[], EngineError>;
	publisher: (publish: CommitPublisher) => void;
};
export const CommitStage = Context.Reference<CommitStageShape | undefined>('bolt/CommitStage', {
	defaultValue: () => undefined
});

/** A guarded provisional write and its post-image approval baseline settle in the same locked native batch. */
export const executeCommit = Effect.fn('Bolt.executeCommit')(function* (
	db: TenantDbShape,
	manifest: EngineManifest,
	catalog: Catalog,
	commit: Commit,
	lock?: Lock
) {
	const stage = yield* CommitStage;
	if (stage !== undefined) return yield* stage.execute(db, manifest, catalog, commit, lock);
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
	const statements = compileCommit(manifest, catalog, commit);
	const results = yield* db.transaction({
		statements: [
			...statements,
			...(guarded && commit.approval !== undefined
				? [readGuardBaseline(commit.approval.requestId, guards, guards.sourceEpoch)]
				: [])
		],
		...(locked === undefined ? {} : { lock: locked })
	});
	return yield* Schema.decodeUnknownEffect(Schema.Array(CommitAnswer))(
		results[statements.length - 1]?.rows ?? []
	).pipe(Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error)));
});

/** Native net effects become visible only with the outer transaction receipt. */
export function transactionEffects(
	m: EngineManifest,
	c: Chain,
	now: string,
	actor: EngineActor,
	captured: readonly Captured[],
	held = false
): void {
	const source = c.cte(
		'transaction_effects',
		`SELECT x.* FROM jsonb_to_recordset(${c.p(
			captured.map((row) => ({
				c: row.collection,
				id: row.id,
				revision: row.revision,
				op: row.op,
				cause: row.cause,
				erased: row.cause === 'erased',
				o: row.old,
				n: row.new
			}))
		)}::jsonb) AS x(c text,id text,revision int,op text,cause text,erased boolean,o jsonb,n jsonb) WHERE ${GATED}`
	);
	queueTriggered(m, c, now, actorRef(actor), source);
	const written = new Set(captured.map((row) => row.collection));
	const notified = Object.entries(m.collections).filter(
		([model, spec]) => spec.notify === true && written.has(model)
	);
	if (notified.length > 0)
		enqueue(c, {
			select: notified
				.map(
					([
						model
					]) => `SELECT 'bolt.notify'::text AS automation, jsonb_build_object('collection', ${c.p(model)}::text,
		'event', jsonb_build_object('kind', 'write', 'action', e.op, 'records', jsonb_agg(coalesce(e.n,e.o) ORDER BY e.id),
		'previous', jsonb_agg(e.o ORDER BY e.id), 'actor', ${c.p(actor)}::jsonb)) AS input,
		${c.p(now)}::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth FROM ${source} e
		WHERE e.c = ${c.p(model)} AND e.cause = 'direct' GROUP BY e.op`
				)
				.join(' UNION ALL ')
		});
	if (!held) syncOutboxPiece(m, c, now, written, actor, source);
}

/** SQL owns what was queued and which links changed; publish only after its successful commit. */
export const committed: (
	answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>,
	outcome?: WriteOutcome
) => Effect.Effect<number, never, Live | Wake | Links> = Effect.fn('Bolt.committed')(function* (
	answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>,
	outcome?: WriteOutcome
) {
	const live = yield* Live;
	const stage = yield* CommitStage;
	if (stage !== undefined) {
		const wake = yield* Wake,
			links = yield* Links;
		stage.publisher((next, settled) =>
			committed(next, settled).pipe(
				Effect.provideService(Live, live),
				Effect.provideService(Wake, wake),
				Effect.provideService(Links, links),
				Effect.provideService(CommitStage, undefined),
				Effect.provideService(SqlSessionDb, undefined)
			)
		);
		return yield* live.v;
	}
	if (answer.next_due !== null) yield* (yield* Wake).at(answer.next_due);
	if (answer.changed_instances.length > 0) {
		const links = yield* Links;
		yield* Effect.forEach(answer.changed_instances, (instance) => links.changed(instance), {
			discard: true
		});
	}
	if (outcome?.kind === 'pendingApproval')
		live.syncChanged('approval_request', [outcome.requestId]);
	return live.publish(answer.captured);
});
