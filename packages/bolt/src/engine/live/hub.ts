// The live engine (rules 64–66, §5.7): one lane per cell. A commit's RETURNING set is routed host-side: each view is
// judged in memory against the pre- and post-images, and a hit is sent as a patch built from the post-image (projected
// through the view's select and the caller's masks, placed by its order), with no read. A delta that cannot be exact
// falls back as narrowly as it can — a PK `get` of the one row, else a re-read of the view — and is counted
// (`conservative=`, listed by `sweep()`). Commits coalesce per lane batch; each connection's fallbacks are one pipelined
// read. Budgets are typed errors on the view; the stream is untouched.
import { Decimal } from '@norbital-ai/std/decimal';
import { encodeWire } from '@norbital-ai/std/wire';
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Equal,
	Exit,
	FiberMap,
	Layer,
	Option,
	Predicate,
	Queue,
	Result,
	Schema,
	Scope,
	Stream
} from 'effect';
import { bindingsAt } from '../query/reader.ts';
import { Live, Manifest, Reads, type LiveView } from '../services.ts';
import type { Json } from '../../decl/values.ts';
import type { Frame, LiveErrorCode, PatchOp } from '../../protocol/wire.ts';
import type { Authority, Bindings, Captured, RowData } from '../contracts.ts';
import type { Pred, SelectIR } from '@norbital-ai/store';
import type { ReadIR } from '../../protocol/reads.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError, storeSync } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { syncsOf } from '../sync/index.ts';
import { ReadDeps, readTargets, selectTargets, sortTargets } from '../query/engine.ts';
import { approvable } from '../approvals/lock.ts';
import {
	conversationRow,
	CONVERSATIONS,
	isStaff,
	listed,
	transcriptRow,
	Message
} from '../agent/schema.ts';
import { collectionOf, defaultFields, type FieldInfo } from '@norbital-ai/store';
import { evaluate, type EvalEnv } from '../query/eval.ts';

const MiB = 1024 * 1024;
/** §4.9's live row: per subscription / per connection / retained per cell. */
export const LIVE = {
	subscriptionBytes: 2 * MiB,
	perConnection: 500,
	cellBytes: 128 * MiB,
	onDebounceMs: 5_000
} as const;

/** The inbox's page (L-BOLT-354). */
export const INBOX_LIMIT = 200;
/** A notice image (a capture's `new`, or `to_jsonb` of the row) as the inbox shows it. */
export const noticeRow = (r: RowData): { [k: string]: Json } => ({
	id: r['id']!,
	title: r['title']!,
	body: r['body'] ?? null,
	link: r['link'] ?? null,
	at: r['at']!,
	read: r['read_at'] !== null && r['read_at'] !== undefined
});
/** `value`: the view's current answer as the connection holds it (after every frame sent), `undefined` before the first. */
type View = LiveView & {
	id: string;
	bytes: number;
	value: Json | undefined;
	arrivalsAfter: number | undefined;
	conservative?: true;
	dependencies: ReadonlySet<string>;
};
type Conn = {
	id: string;
	authority: Authority;
	send(frame: Frame): void;
	end(): void;
	views: Map<string, View>;
	scope: Scope.Closeable;
	fibers: FiberMap.FiberMap<string, void, never>;
};

type Row = { readonly [field: string]: Json };
const PageSchema = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	next: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const pageOf = Schema.decodeUnknownOption(PageSchema);
const rowOf = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
type Read = Extract<ReadIR, { kind: 'read' }>;
/** Reads whose answer is a `{ rows }` page the engine answers itself, placed by its own order. */
type Own = Extract<ReadIR, { kind: 'transcript' | 'inbox' | 'conversations' }>;
/** What one captured row is to a view: its row as the view shows it (`null`: not in it), a PK `get` of it, or a re-read. */
type Resolved = { c: Captured; row: Row | null } | { c: Captured; get: ReadIR } | 'full';
type Answer = { ok: Json } | { err: unknown };

const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
/** Relation, period and point predicates need rows or column forms the RETURNING image does not carry. */
function decidable(p: Pred): boolean {
	switch (p.t) {
		case 'and':
		case 'or':
			return p.of.every(decidable);
		case 'not':
			return decidable(p.of);
		case 'one':
		case 'many':
		case 'count':
		case 'agg':
		case 'geo':
		case 'period':
		case 'path':
		case 'each':
		case 'search':
		case 'similar':
			return false; // hook:query (agg)
		case 'const':
			return true;
		default:
			return (
				!p.field.includes('.') &&
				!(p.t === 'cmp' && p.arg._tag === 'Field' && p.arg.field.includes('.'))
			);
	}
}
/** Keys in jsonb's order (length, then bytes), so a built row prints as the database's does. */
const jb = (o: { [k: string]: Json }): Row =>
	Object.fromEntries(
		Object.entries(o).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
	);
const same = (a: Json | undefined, b: Json) =>
	a !== undefined && Equal.equals(encodeWire(a), encodeWire(b));
const iso = (s: string): string | undefined => {
	const t = Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
	return Number.isNaN(t) || !/^\d{4}-/.test(s) ? undefined : new Date(t).toISOString();
};
const dayBefore = (d: string) =>
	new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * A RETURNING value (`to_jsonb(row)`, parsed) in the read's wire form (`sql.ts` `wire`, std/wire), or `undefined` when it
 * cannot be exact. A commit's image carries `numeric` as text (`commit.ts` `numericText`), so a decimal, money or sum keeps
 * its scale; a JSON number (an approval seal's or restore's image) has lost it (`1.20` → 1.2) and falls back to a PK get.
 */
function wireOf(f: FieldInfo, v: Json | undefined): Json | undefined {
	if (v === undefined || v === null) return v;
	switch (f.pg) {
		case 'numeric':
			return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)
				? encodeWire(Decimal.of(v))
				: undefined;
		case 'timestamptz':
			return typeof v === 'string' ? iso(v) : undefined;
		case 'date':
			return typeof v === 'string' ? v : undefined;
		case 'vector':
			return typeof v === 'string'
				? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(JSON.parse(v)))
				: v;
		case 'point': {
			const p = typeof v === 'string' ? /^\(([^,]+),([^)]+)\)$/.exec(v) : null;
			return p === null ? undefined : { lat: Number(p[2]), lng: Number(p[1]) };
		}
		case 'daterange': {
			const p = typeof v === 'string' ? /^\[(\d{4}-\d\d-\d\d),(\d{4}-\d\d-\d\d)?\)$/.exec(v) : null;
			return p === null
				? undefined
				: jb({ from: p[1]!, to: p[2] === undefined ? null : dayBefore(p[2]) });
		}
		case 'tstzrange': {
			const p = typeof v === 'string' ? /^[[(]"([^"]+)",(?:"([^"]+)")?[\])]$/.exec(v) : null;
			const start = p === null ? undefined : iso(p[1]!),
				end = p?.[2] === undefined ? null : iso(p[2]);
			return start === undefined || end === undefined ? undefined : jb({ start, end });
		}
		default:
			return v;
	}
}
/** A wire value as the order compares it: `undefined` when the row does not carry it; a mask reads as null (`sql.ts` `col`). */
function sortable(v: Json | undefined): string | number | boolean | null | undefined {
	if (v === undefined || v === null) return v;
	if (typeof v !== 'object') return v;
	if (!Predicate.isObject(v)) return undefined;
	if ('$masked' in v) return null;
	return typeof v['$dec'] === 'string' ? Number(v['$dec']) : undefined;
}

export const LiveHubLive = Layer.effect(
	Live,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const reader = yield* Reads;
		const generation = yield* Scope.Scope;
		const bindings = Clock.currentTimeMillis.pipe(
			Effect.map((at) => bindingsAt(at, manifest.workspace.tz))
		);
		const cat = catalogOf(manifest);
		const lane = yield* Queue.unbounded<
			| { readonly _tag: 'Flush' }
			| { readonly _tag: 'Barrier'; readonly done: Deferred.Deferred<void> }
		>();
		// an envoy declared `public` serves anyone, so its threads are in every member's list (the `conversations` read)
		const publicEnvoys = () =>
			Object.entries(manifest.envoys)
				.filter(([, e]) => e.audience === 'public')
				.map(([n]) => n);
		const conns = new Map<string, Conn>();
		// `v`: the last commit's sequence; `routed`: the last one whose views were answered (frames are stamped with it)
		let v = 0,
			routed = 0,
			retained = 0,
			conservative = 0,
			n = 0,
			reads = 0;
		let pending: { captured: Captured; version: number }[] = [],
			queued = false;
		let syncChanges = new Map<string, Set<string> | null>();
		const queue = () => {
			if (queued) return;
			queued = true;
			Queue.offerUnsafe(lane, { _tag: 'Flush' });
		};

		/** Cursor pages and prospective reads have no live registration. Index searches re-answer on model writes. */
		function check(view: LiveView): void {
			if (view.batch !== undefined) {
				for (const read of view.batch.reads) check({ read });
				return;
			}
			const r = view.read;
			if (
				r.kind === 'after' ||
				(r.kind === 'read' && r.page._tag === 'Limit' && r.page.after !== undefined)
			)
				throw BoltError.make(
					'invalid',
					'decode',
					`a ${r.kind === 'read' ? 'cursor page' : r.kind} read is not liveable`
				);
		}

		/** The RETURNING image with each exclusive arc also under its field name as a `RecordRef`, as the evaluator and the wire read it. */
		const images = new WeakMap<RowData, RowData>();
		function image(collection: string, row: RowData): RowData {
			const hit = images.get(row);
			if (hit !== undefined) return hit;
			let out: { [k: string]: Json } | null = null;
			for (const f of cat.models.get(collection)?.fields.values() ?? []) {
				if (f.arms === undefined || f.arms.some((a) => row[`${f.column}__${a}`] === undefined))
					continue;
				const arm = f.arms.find((a) => row[`${f.column}__${a}`] !== null);
				(out ??= { ...row })[f.name] =
					arm === undefined ? null : jb({ collection: arm, id: row[`${f.column}__${arm}`]! });
			}
			images.set(row, out ?? row);
			return out ?? row;
		}
		/** Whether a row image is one of the view's rows for this caller: a read arm admits it and the view's `where` holds. */
		function member(
			a: Authority,
			r: { collection: string; where?: Pred | undefined },
			row: RowData,
			b: Bindings
		): boolean {
			const arms = a.admin ? null : (a.collections[r.collection]?.read ?? []);
			const env: EvalEnv = { cat, bindings: b, authority: a, scoped: true };
			return (
				(arms === null ||
					arms.some((x) => evaluate({ ...env, scoped: false }, r.collection, x.where, row))) &&
				(r.where === undefined || evaluate(env, r.collection, r.where, row))
			);
		}

		/** What a captured row means for a view: skip, a decided hit, or undecidable. */
		function decide(
			a: Authority,
			view: View,
			c: Captured,
			b: Bindings
		): 'skip' | 'hit' | 'unknown' {
			const r = view.read;
			if (view.batch !== undefined) return view.dependencies.has(c.collection) ? 'unknown' : 'skip';
			// a commit to a related sort key's target (a renamed account) may reorder rows it does not carry: re-read
			if (r.kind === 'read' && sortTargets(cat, r.collection, r.order).has(c.collection))
				return 'unknown';
			if (c.collection !== r.collection)
				return (r.kind === 'read' || r.kind === 'get') &&
					selectTargets(cat, r.select).has(c.collection)
					? 'unknown'
					: 'skip';
			if (r.kind === 'get' || r.kind === 'history') return c.id === r.id ? 'hit' : 'skip';
			const arms = a.admin ? null : (a.collections[c.collection]?.read ?? []);
			if (r.kind !== 'read' && r.kind !== 'aggregate' && r.kind !== 'similar') return 'unknown';
			if ((r.where !== undefined && !decidable(r.where)) || arms?.some((x) => !decidable(x.where)))
				return 'unknown';
			const hit = (row: RowData | null) =>
				row !== null && member(a, r, image(c.collection, row), b);
			return Result.getOrElse(
				Result.try(() => (hit(c.old) || hit(c.new) ? ('hit' as const) : ('skip' as const))),
				() => 'unknown' as const
			);
		}

		/** A row image as the read projects it (`sql.ts` `items`): `id`, the selected fields in wire form, a mask as `$masked`;
		 * `undefined` when the image cannot give it exactly (a relation arm, an arc arm field, a numeric number, a column it lacks). */
		function project(
			a: Authority,
			collection: string,
			select: SelectIR,
			row: RowData,
			one: boolean,
			b: Bindings
		): Row | undefined {
			if (
				Object.keys(select.relations).length > 0 ||
				[...syncsOf(manifest).values()].some((sync) => sync.model === collection && sync.write) ||
				approvable(manifest, cat).has(collection)
			)
				return undefined; // `$sync` and `$approval` are read, never in an image
			const c = storeSync(collectionOf(cat, collection));
			const out: { [k: string]: Json } = { id: row['id']! };
			for (const name of select.fields ?? defaultFields(c, one)) {
				if (name === 'id') continue;
				const f = c.model.fields.get(name);
				if (f === undefined || name.includes('.')) return undefined;
				const value = f.arms === undefined ? wireOf(f, row[f.column]) : row[name];
				if (value === undefined) return undefined;
				const mask = a.admin ? undefined : a.collections[collection]?.masks[name];
				out[name] =
					mask === undefined ||
					evaluate({ cat, bindings: b, authority: a, scoped: false }, collection, mask, row)
						? value
						: { $masked: true };
			}
			return jb(out);
		}

		function resolve(a: Authority, view: View, c: Captured, b: Bindings): Resolved {
			const r = view.read;
			if ((r.kind !== 'read' && r.kind !== 'get') || (r.kind === 'read' && r.search !== undefined))
				return 'full';
			if (c.new === null) return { c, row: null };
			const row = image(c.collection, c.new);
			const projected = Result.try(() =>
				!member(a, r.kind === 'get' ? { collection: r.collection } : r, row, b)
					? null
					: project(a, r.collection, r.select, row, r.kind === 'get', b)
			);
			if (Result.isFailure(projected)) return 'full';
			if (projected.success !== undefined) return { c, row: projected.success };
			// the one row, read as the view reads it (a list's default projection, not a record's)
			return r.kind === 'get'
				? 'full'
				: {
						c,
						get: {
							kind: 'get',
							collection: r.collection,
							id: c.id,
							select: {
								fields:
									r.select.fields ?? defaultFields(storeSync(collectionOf(cat, r.collection))),
								relations: r.select.relations
							}
						}
					};
		}

		/** Where `row` goes among `rows` by the view's order (nulls last ascending, first descending, then `id`), or `null` when
		 * it cannot be exact: a key the rows do not carry, or two different text values, whose order is the database collation's. */
		function place(r: ReadIR, rows: readonly Row[], row: Row): number | null {
			if (r.kind !== 'read') return null;
			const fields = storeSync(collectionOf(cat, r.collection)).model.fields;
			const keys = [...(r.order ?? []), { field: 'id', dir: 'asc' as const }];
			const before = (x: Row, y: Row): boolean | null => {
				for (const k of keys) {
					// a distance is the database's to compute: a row that moves re-reads
					if ('near' in k && k.near !== undefined) return null;
					const p = sortable(x[k.field]),
						q = sortable(y[k.field]);
					if (p === undefined || q === undefined) return null;
					if (p === q) continue;
					if (p === null || q === null) return (p === null) === (k.dir === 'desc');
					if (fields.get(k.field)?.pg === 'text') return null; // ponytail: collation-ordered text re-reads; learn the collation to place it
					return p < q === (k.dir === 'asc');
				}
				return false;
			};
			for (let i = 0; i < rows.length; i++) {
				const b = before(row, rows[i]!);
				if (b === null) return null;
				if (b) return i;
			}
			return rows.length;
		}
		/** Whether the change leaves the row's order keys as they were, so it stays where it is. */
		function kept(r: ReadIR, a: Authority, c: Captured, old: Row, row: Row): boolean {
			if (r.kind !== 'read') return false;
			const fields = storeSync(collectionOf(cat, r.collection)).model.fields;
			return (r.order ?? []).every(({ field }) => {
				// a related key (`account.name`) holds while its relation does; a commit to the target re-reads (`decide`)
				const head = field.split('.')[0]!,
					col = fields.get(head)?.column ?? head;
				return (
					c.old !== null &&
					c.new !== null &&
					(a.admin || a.collections[r.collection]?.masks[head] === undefined) &&
					same(c.old[col], c.new[col] ?? null)
				);
			});
		}

		type Strategy = {
			decide: typeof decide;
			resolve: typeof resolve;
			place: typeof place;
			kept: typeof kept;
			limit: (read: ReadIR) => number;
		};
		const base: Strategy = {
			decide,
			resolve,
			place,
			kept,
			limit: (read) =>
				read.kind === 'read' && read.page._tag === 'Limit' ? read.page.limit : LIMITS.page.all
		};
		const newest = (read: ReadIR, rows: readonly Row[], row: Row): number => {
			const time = Date.parse(String(row['at'])),
				id = String(row['id']);
			const at = rows.findIndex((other) => {
				const value = Date.parse(String(other['at']));
				return value < time || (value === time && String(other['id']) < id);
			});
			return at < 0 ? rows.length : at;
		};
		const sameAt: Strategy['kept'] = (read, authority, captured, old, row) =>
			old['at'] === row['at'];
		/** Each liveable own read owns its image judgement and projection beside its delegates. */
		const LIVE_KINDS = {
			read: base,
			get: base,
			history: base,
			aggregate: base,
			query: {
				...base,
				decide: (a, view, captured) => (view.dependencies.has(captured.collection) ? 'hit' : 'skip')
			},
			similar: {
				...base,
				decide: (a, view, captured) =>
					captured.collection === view.read.collection ? 'unknown' : 'skip'
			},
			after: { ...base, decide: () => 'unknown' },
			transcript: {
				...base,
				decide: (a, view, captured) =>
					// the answer carries its conversation's status (a stop may change no message): its row re-reads
					view.read.kind === 'transcript' &&
					captured.collection === 'sys_conversation' &&
					(captured.new ?? captured.old)?.['id'] === view.read.conversation
						? Predicate.isObject(view.value) &&
							view.value['status'] === (captured.new ?? captured.old)?.['status']
							? 'skip'
							: 'hit'
						: view.read.kind === 'transcript' &&
							  captured.collection === view.read.collection &&
							  (captured.new ?? captured.old)?.['conversation'] === view.read.conversation &&
							  (view.read.from === undefined ||
									Number((captured.new ?? captured.old)?.['seq']) >= view.read.from)
							? 'hit'
							: 'skip',
				resolve: (a, view, captured) => {
					if (captured.new === null || captured.collection === 'sys_conversation')
						return { c: captured, row: null };
					const message = Schema.decodeUnknownOption(Message)(captured.new);
					if (view.read.kind !== 'transcript' || Option.isNone(message)) return 'full';
					return { c: captured, row: transcriptRow(message.value, isStaff(a), view.read.thread) };
				},
				place: (read, rows, row) => {
					const at = rows.findIndex((other) => Number(other['seq']) > Number(row['seq']));
					return at < 0 ? rows.length : at;
				},
				kept: (read, a, captured, old, row) => old['seq'] === row['seq']
			},
			inbox: {
				...base,
				decide: (a, view, captured) =>
					view.read.kind === 'inbox' &&
					((captured.collection === view.read.collection &&
						(captured.new ?? captured.old)?.['member'] === view.read.member) ||
						(view.read.requests === true && captured.collection === 'sys_user'))
						? 'hit'
						: 'skip',
				resolve: (a, view, captured) => ({
					c: captured,
					row: captured.new === null ? null : noticeRow(captured.new)
				}),
				place: newest,
				kept: sameAt,
				limit: () => INBOX_LIMIT
			},
			conversations: {
				...base,
				decide: (a, view, captured) =>
					view.read.kind === 'conversations' &&
					captured.collection === view.read.collection &&
					listed(captured.new ?? captured.old, view.read.member, publicEnvoys(), a.admin)
						? 'hit'
						: 'skip',
				resolve: (a, view, captured) => ({
					c: captured,
					row: captured.new === null ? null : conversationRow(captured.new)
				}),
				place: newest,
				kept: sameAt,
				limit: () => CONVERSATIONS
			}
		} satisfies { [K in ReadIR['kind']]: Strategy };

		/** Applies one resolved row to a working value; the ops that did it, or `'full'` when only a re-read is exact. */
		function apply(
			a: Authority,
			view: View,
			work: { value: Json },
			c: Captured,
			row: Row | null
		): PatchOp[] | 'full' {
			const r = view.read;
			// a transcript's conversation changed status: set it beside the rows, no re-read
			if (r.kind === 'transcript' && c.collection === 'sys_conversation') {
				const status = c.new?.['status'];
				if (!Predicate.isObject(work.value) || status === undefined) return 'full';
				work.value = { ...work.value, status };
				return [{ op: 'meta', key: 'status', value: status }];
			}
			if (r.kind === 'get') {
				if (row === null)
					return work.value === null ? [] : ((work.value = null), [{ op: 'remove', id: c.id }]);
				if (same(work.value, row)) return [];
				work.value = row;
				return [{ op: 'upsert', index: 0, row }];
			}
			const parsed = pageOf(work.value);
			if (
				(r.kind !== 'read' &&
					r.kind !== 'transcript' &&
					r.kind !== 'inbox' &&
					r.kind !== 'conversations') ||
				Option.isNone(parsed)
			)
				return 'full';
			const page = parsed.value,
				rows = [...page.rows],
				i = rows.findIndex((x) => x['id'] === c.id);
			work.value = { ...page, rows };
			const more = page.next !== undefined && page.next !== null;
			const limit = LIVE_KINDS[r.kind].limit(r);
			if (row === null) {
				if (more) return 'full'; // a row left: from the page, which backfills; or from beyond it, which may end `next`
				if (i < 0) return [];
				rows.splice(i, 1);
				return [{ op: 'remove', id: c.id }];
			}
			if (i >= 0 && LIVE_KINDS[r.kind].kept(r, a, c, rows[i]!, row)) {
				if (same(rows[i], row)) return [];
				rows[i] = row;
				return [{ op: 'upsert', index: i, row }];
			}
			const last = rows.at(-1)?.['id'];
			if (i >= 0) rows.splice(i, 1);
			const at = LIVE_KINDS[r.kind].place(r, rows, row);
			if (at === null) return 'full';
			if (more) {
				// a full page with more beyond: a row past its end is not on it; a row leaving or entering it moves `next`
				if (at === rows.length) return i < 0 ? [] : 'full';
				if (i < 0) return 'full';
				rows.splice(at, 0, row);
				return rows.at(-1)?.['id'] === last ? [{ op: 'upsert', index: at, row }] : 'full';
			}
			if (rows.length + 1 > limit) return 'full';
			rows.splice(at, 0, row);
			return [{ op: 'upsert', index: at, row }];
		}

		/** Sends a view's new value: its ops as a patch, or the whole answer; over a budget, the view errors alone. */
		const put = Effect.fn('Live.put')(function* (
			conn: Conn,
			view: View,
			value: Json,
			ops?: readonly PatchOp[],
			arrivals?: readonly Json[]
		) {
			const text = JSON.stringify(value);
			if (
				ops === undefined &&
				!arrivals?.length &&
				view.value !== undefined &&
				same(view.value, value)
			)
				return;
			const bytes = bytesOf(text);
			const over: [LiveErrorCode, string] | null =
				bytes > LIVE.subscriptionBytes
					? [
							'subscriptionTooLarge',
							`the answer is ${bytes} bytes; a live view holds at most ${LIVE.subscriptionBytes}`
						]
					: retained - view.bytes + bytes > LIVE.cellBytes
						? ['cellBudget', `the cell retains at most ${LIVE.cellBytes} bytes of live answers`]
						: null;
			if (over !== null) {
				yield* drop(conn, view.id);
				conn.send({ t: 'error', view: view.id, code: over[0], message: over[1] });
				return;
			}
			retained += bytes - view.bytes;
			view.bytes = bytes;
			view.value = value;
			conn.send(
				ops === undefined
					? {
							t: 'answer',
							view: view.id,
							v: routed,
							value,
							...(arrivals?.length ? { arrivals } : {})
						}
					: { t: 'patch', view: view.id, v: routed, ops }
			);
		});
		const failed = (conn: Conn, view: View, err: unknown) =>
			conn.send({
				t: 'error',
				view: view.id,
				code: err instanceof BoltError ? err.code : 'internal',
				message: err instanceof Error ? err.message : String(err)
			});

		/** One pipelined read; a failing batch is re-asked per read so one bad view errors alone. */
		const readAll = Effect.fn('Live.readAll')(function* (
			conn: Conn,
			batch: readonly ReadIR[],
			b: Bindings
		) {
			if (batch.length === 0) return [];
			reads += batch.length;
			return yield* reader.run(batch, { as: 'caller', authority: conn.authority }, b).pipe(
				Effect.map((values): readonly Answer[] => values.map((ok) => ({ ok }))),
				Effect.catch(() =>
					Effect.forEach(
						batch,
						(read) =>
							reader.run([read], { as: 'caller', authority: conn.authority }, b).pipe(
								Effect.match({
									onSuccess: (values): Answer => ({ ok: values[0] ?? null }),
									onFailure: (err): Answer => ({ err })
								})
							),
						{ concurrency: 'unbounded' }
					)
				)
			);
		});
		const answer = Effect.fn('Live.answer')(function* (conn: Conn, views: readonly View[]) {
			const b = yield* bindings;
			const ordinary = views.filter(
				(view) => view.batch === undefined && view.read.kind !== 'query'
			);
			const values = yield* readAll(
				conn,
				ordinary.map((view) => view.read),
				b
			);
			for (const [i, view] of ordinary.entries()) {
				if (!conn.views.has(view.id)) continue;
				const result = values[i];
				if (result === undefined) continue;
				if ('ok' in result) yield* put(conn, view, result.ok);
				else failed(conn, view, result.err);
			}
			for (const view of views.filter(
				(view) => view.batch !== undefined || view.read.kind === 'query'
			)) {
				const batch = view.batch?.reads ?? [view.read];
				const dependencies = new Set(
					batch.flatMap((read) => [...readTargets(cat, read, conn.authority)])
				);
				const results = yield* readAll(conn, batch, b).pipe(
					Effect.provideService(ReadDeps, dependencies)
				);
				if (!conn.views.has(view.id)) continue;
				const error = results.find((result) => 'err' in result);
				if (error !== undefined && 'err' in error) failed(conn, view, error.err);
				else {
					view.dependencies = dependencies;
					const values = results.map((result) => ('ok' in result ? result.ok : null));
					const value =
						view.batch === undefined
							? values[0]
							: Object.fromEntries(
									view.batch.keys.map((key, index) => [key, values[index] ?? null])
								);
					if (value !== undefined) yield* put(conn, view, value);
				}
			}
		});
		const drop = Effect.fn('Live.dropView')(function* (conn: Conn, id: string) {
			const view = conn.views.get(id);
			if (view === undefined) return;
			retained -= view.bytes;
			conn.views.delete(id);
			yield* FiberMap.remove(conn.fibers, `debounce:${id}`);
		});
		const disconnect = Effect.fn('Live.disconnect')(function* (id: string) {
			const conn = conns.get(id);
			if (conn === undefined) return;
			for (const view of conn.views.values()) retained -= view.bytes;
			conn.views.clear();
			conns.delete(id);
			yield* Scope.close(conn.scope, Exit.void);
			conn.end();
		});

		const flush = Effect.fn('Live.flush')(function* () {
			queued = false;
			routed = v;
			const batch = pending;
			pending = [];
			const metadata = syncChanges;
			syncChanges = new Map();
			const b = yield* bindings;
			let hit = 0,
				patched = 0,
				fallback = 0;
			reads = 0;
			yield* Effect.forEach(
				[...conns.values()],
				(conn) =>
					Effect.gen(function* () {
						const full: View[] = [],
							deltas: { view: View; rows: Exclude<Resolved, 'full'>[] }[] = [];
						for (const view of conn.views.values()) {
							const hits: Captured[] = [];
							const read = view.read;
							const changed =
								read.kind === 'get' || read.kind === 'read'
									? metadata.get(read.collection)
									: undefined;
							let unsure =
								((read.kind === 'query' || view.batch !== undefined) &&
									[...metadata.keys()].some((model) => view.dependencies.has(model))) ||
								(read.kind === 'inbox' && metadata.has(read.collection)) ||
								(read.kind === 'inbox' &&
									read.requests === true &&
									metadata.has('approval_request')) ||
								changed === null ||
								(changed !== undefined &&
									(read.kind === 'get'
										? changed.has(read.id)
										: view.value === undefined ||
											(Predicate.isObject(view.value) &&
												Array.isArray(view.value['rows']) &&
												view.value['rows'].some(
													(row: Json) =>
														Predicate.isObject(row) &&
														typeof row['id'] === 'string' &&
														changed.has(row['id'])
												))));
							for (const { captured: c } of batch) {
								const d = LIVE_KINDS[view.read.kind].decide(conn.authority, view, c, b);
								if (d === 'unknown') unsure = true;
								else if (d === 'hit') hits.push(c);
							}
							if (!unsure && hits.length === 0) continue;
							hit++;
							if (view.read.kind === 'query' || view.batch !== undefined) {
								// a collection query re-runs debounced, shared by nothing else on this connection
								yield* FiberMap.run(
									conn.fibers,
									`debounce:${view.id}`,
									Effect.sleep(LIVE.onDebounceMs).pipe(
										Effect.andThen(answer(conn, [view])),
										Effect.asVoid
									),
									{ onlyIfMissing: true }
								);
								continue;
							}
							// Inbox counts cover rows beyond the displayed page, including old:null read captures.
							const rows =
								unsure || view.value === undefined || view.read.kind === 'inbox'
									? ['full' as const]
									: hits.map((c) => LIVE_KINDS[view.read.kind].resolve(conn.authority, view, c, b));
							if (rows.includes('full')) full.push(view);
							else
								deltas.push({
									view,
									rows: rows.filter((row): row is Exclude<Resolved, 'full'> => row !== 'full')
								});
						}
						// the fallbacks, in one round trip: whole views, then single rows by id
						const gets = deltas.flatMap((d) => d.rows.flatMap((x) => ('get' in x ? [x.get] : [])));
						const values = yield* readAll(conn, [...full.map((x) => x.read), ...gets], b);
						for (const [i, view] of full.entries()) {
							const r = values[i];
							if (r === undefined) continue;
							if (conn.views.has(view.id)) {
								if ('ok' in r) {
									const read = view.read;
									const after = view.arrivalsAfter;
									const arrivals =
										read.kind === 'inbox' && after !== undefined
											? batch.flatMap(({ captured: c, version }) =>
													version > after &&
													c.collection === read.collection &&
													c.op === 'create' &&
													c.new?.['member'] === read.member
														? [noticeRow(c.new)]
														: []
												)
											: undefined;
									yield* put(conn, view, r.ok, undefined, arrivals);
								} else failed(conn, view, r.err);
							}
						}
						let k = full.length;
						const again: View[] = [];
						for (const { view, rows } of deltas) {
							const got = rows.map((x) => ('get' in x ? values[k++]! : null));
							if (!conn.views.has(view.id)) continue;
							if (got.some((x) => x !== null)) {
								fallback++;
								view.conservative = true;
							}
							if (view.value === undefined) {
								again.push(view);
								continue;
							}
							const work = { value: view.value };
							const ops: PatchOp[] = [];
							let exact = true;
							for (const [i, x] of rows.entries()) {
								const g = got[i];
								if (g !== null && g !== undefined && 'err' in g) {
									exact = false;
									break;
								}
								const projected =
									'row' in x
										? Option.some(x.row)
										: g !== null && g !== undefined && 'ok' in g
											? g.ok === null
												? Option.some(null)
												: rowOf(g.ok)
											: Option.none();
								if (Option.isNone(projected)) {
									exact = false;
									break;
								}
								const o = apply(conn.authority, view, work, x.c, projected.value);
								if (o === 'full') {
									exact = false;
									break;
								}
								ops.push(...o);
							}
							if (!exact) {
								again.push(view);
								continue;
							}
							if (ops.length === 0) continue;
							patched++;
							yield* put(conn, view, work.value, ops);
						}
						for (const view of [...full, ...again]) view.conservative = true;
						fallback += full.length + again.length;
						yield* answer(conn, again); // rare: a page boundary moved or an order needed the collation
						conn.send({ t: 'v', v: routed });
					}),
				{ concurrency: 'unbounded', discard: true }
			);
			conservative += fallback;
			yield* Effect.logDebug(
				`live v=${routed} rows=${batch.length} views=${hit} patched=${patched} conservative=${fallback} reads=${reads}`
			);
		});

		yield* Effect.gen(function* () {
			while (true) {
				const work = yield* Queue.take(lane);
				if (work._tag === 'Barrier') yield* Deferred.succeed(work.done, undefined);
				else yield* flush();
			}
		}).pipe(Effect.forkScoped);
		yield* Effect.addFinalizer(() =>
			Effect.forEach([...conns.keys()], disconnect, { discard: true })
		);
		return Live.of({
			v: Effect.sync(() => v),
			connect: (authority) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const frames = yield* Queue.unbounded<Frame, Cause.Done>();
						const scope = yield* Scope.fork(generation);
						const fibers = yield* FiberMap.make<string, void, never>().pipe(Scope.provide(scope));
						const id = `c${++n}`;
						const conn: Conn = {
							id,
							authority,
							views: new Map(),
							scope,
							fibers,
							send: (frame) => {
								Queue.offerUnsafe(frames, frame);
							},
							end: () => {
								Queue.endUnsafe(frames);
							}
						};
						conns.set(id, conn);
						conn.send({ t: 'hello', conn: id, v: routed });
						yield* Effect.addFinalizer(() => disconnect(id));
						return Stream.fromQueue(frames);
					})
				),
			authorityOf: (id) => Effect.sync(() => Option.fromNullishOr(conns.get(id)?.authority)),
			register: Effect.fn('Live.register')(function* (connId: string, id: string, view: LiveView) {
				const conn = conns.get(connId);
				if (conn === undefined)
					return yield* Effect.fail(
						BoltError.make('notFound', 'admission', 'the live connection is gone')
					);
				yield* Effect.try({
					try: () => check(view),
					catch: (error) =>
						error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
				});
				if (!conn.views.has(id) && conn.views.size >= LIVE.perConnection)
					return yield* Effect.fail(
						BoltError.make(
							'tooManySubscriptions',
							'admission',
							`a connection holds at most ${LIVE.perConnection} live views`
						)
					);
				yield* drop(conn, id);
				const state: View = {
					...view,
					id,
					bytes: 0,
					value: undefined,
					arrivalsAfter: undefined,
					dependencies: new Set()
				};
				conn.views.set(id, state);
				yield* answer(conn, [state]);
				state.arrivalsAfter = v;
			}),
			drop: (connId, id) => {
				const conn = conns.get(connId);
				return conn === undefined ? Effect.void : drop(conn, id);
			},

			/** Rule 66: routes one commit's RETURNING set; returns the lane sequence the act replies with. */
			publish(captured: readonly Captured[]): number {
				if (captured.length === 0) return v;
				v++;
				pending.push(...captured.map((row) => ({ captured: row, version: v })));
				queue();
				return v;
			},
			/** Re-read affected views after native metadata commits, without domain captures or hooks. Omit records to invalidate the collection. */
			syncChanged(collection: string, records?: readonly string[]): number {
				if (records?.length === 0) return v;
				v++;
				const previous = syncChanges.get(collection);
				if (records === undefined || previous === null) syncChanges.set(collection, null);
				else {
					const ids = previous ?? new Set<string>();
					for (const record of records) ids.add(record);
					syncChanges.set(collection, ids);
				}
				queue();
				return v;
			},
			sweep: Effect.sync(() => ({
				conservative,
				views: [...conns.values()].flatMap((conn) =>
					[...conn.views.values()]
						.filter((view) => view.conservative)
						.map((view) => `${conn.id}/${view.id}`)
				)
			})),
			retained: Effect.sync(() => retained),

			settled: Effect.gen(function* () {
				const done = yield* Deferred.make<void>();
				yield* Queue.offer(lane, { _tag: 'Barrier', done });
				yield* Deferred.await(done);
			}),
			authorize: Effect.fn('Live.authorize')(function* (connId: string, authority: Authority) {
				const conn = conns.get(connId);
				if (conn === undefined) return;
				conn.authority = authority;
				for (const view of conn.views.values()) view.value = undefined;
				yield* answer(conn, [...conn.views.values()]);
			}),
			close: Effect.fn('Live.close')(function* (release: string) {
				for (const conn of [...conns.values()]) {
					conn.send({ t: 'close', release });
					yield* disconnect(conn.id);
				}
			})
		});
	})
);
