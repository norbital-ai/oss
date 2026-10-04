// The live engine (rules 64–66, §5.7): one lane per cell. A commit's RETURNING set is routed host-side: each view is
// judged in memory against the pre- and post-images, and a hit is sent as a patch built from the post-image (projected
// through the view's select and the caller's masks, placed by its order), with no read. A delta that cannot be exact
// falls back as narrowly as it can — a PK `get` of the one row, else a re-read of the view — and is counted
// (`conservative=`, listed by `sweep()`). Commits coalesce per lane batch; each connection's fallbacks are one pipelined
// read. Budgets are typed errors on the view; the stream is untouched.
import type { Json } from '../../decl/values.ts';
import type { Frame, LiveErrorCode, PatchOp } from '../../protocol/wire.ts';
import type { Authority, Bindings, Captured, EngineManifest, Order, Pred, ReadIR, RowData, SelectIR } from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { conversationRow, CONVERSATIONS, isStaff, listed, transcriptRow, type MessageRow } from '../agent/schema.ts';
import { collectionOf, defaultFields, type Catalog, type FieldInfo } from '../../protocol/catalog.ts';
import { evaluate, offsetMs, type EvalEnv } from '../query/eval.ts';

const MiB = 1024 * 1024;
/** §4.9's live row: per subscription / per connection / retained per cell. */
export const LIVE = { subscriptionBytes: 2 * MiB, perConnection: 500, cellBytes: 128 * MiB, onDebounceMs: 5_000 } as const;

export type LiveView = { read: ReadIR; every?: string; on?: readonly string[] };
/** The inbox's page (L-BOLT-354). */
export const INBOX_LIMIT = 200;
/** A notice image (a capture's `new`, or `to_jsonb` of the row) as the inbox shows it. */
export const noticeRow = (r: RowData): { [k: string]: Json } => ({ id: r['id']!, title: r['title']!, body: r['body'] ?? null, link: r['link'] ?? null,
	at: r['at']!, read: r['read_at'] !== null && r['read_at'] !== undefined });
/** `value`: the view's current answer as the connection holds it (after every frame sent), `undefined` before the first. */
type View = LiveView & { id: string; bytes: number; value: Json | undefined; timer?: ReturnType<typeof setTimeout> | undefined; conservative?: true };
type Conn = { id: string; authority: Authority; send(frame: Frame): void; end(): void; views: Map<string, View> };
export type LiveConfig = {
	manifest: EngineManifest;
	/** The caller's batch read (the read engine as `{ as: 'caller', authority }`): one round trip. */
	read(batch: readonly ReadIR[], authority: Authority, bindings: Bindings): Promise<readonly Json[]>;
	bindings(): Bindings;
	log?(line: string): void;
};
export type LiveHub = ReturnType<typeof liveHub>;

type Row = { readonly [field: string]: Json };
type Page = { rows: Row[]; next?: string | null };
type Read = Extract<ReadIR, { kind: 'read' }>;
/** Reads whose answer is a `{ rows }` page the engine answers itself, placed by its own order. */
type Own = Extract<ReadIR, { kind: 'transcript' | 'inbox' | 'conversations' }>;
/** What one captured row is to a view: its row as the view shows it (`null`: not in it), a PK `get` of it, or a re-read. */
type Resolved = { c: Captured; row: Row | null } | { c: Captured; get: ReadIR } | 'full';
type Answer = { ok: Json } | { err: unknown };

const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
const CLOCK = /"(now|today|startOf)":/; // hook:query (startOf)
/** Relation, period and point predicates need rows or column forms the RETURNING image does not carry. */
function decidable(p: Pred): boolean {
	switch (p.t) {
		case 'and': case 'or': return p.of.every(decidable);
		case 'not': return decidable(p.of);
		case 'one': case 'many': case 'count': case 'agg': case 'geo': case 'period': return false; // hook:query (agg)
		case 'const': return true;
		default: return !p.field.includes('.') && !(p.t === 'cmp' && 'field' in p.arg && p.arg.field.includes('.'));
	}
}
/** Collections a related sort key reads (`account.name` → accounts): the image cannot place rows by their values. */
function sortTargets(cat: Catalog, collection: string, order: Order | undefined, out = new Set<string>()): Set<string> {
	for (const { field } of order ?? []) {
		let m = collection;
		for (const s of field.split('.').slice(0, -1)) out.add(m = cat.models.get(m)?.one.get(s)?.targets[0] ?? m);
	}
	return out;
}
const targets = (cat: Catalog, s: SelectIR, out = new Set<string>()): Set<string> => {
	for (const r of Object.values(s.relations)) targets(cat, r.select, sortTargets(cat, r.target, r.order, out.add(r.target)));
	return out;
};
/** Keys in jsonb's order (length, then bytes), so a built row prints as the database's does. */
const jb = (o: { [k: string]: Json }): Row => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)));
const same = (a: Json | undefined, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const iso = (s: string): string | undefined => {
	const t = Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
	return Number.isNaN(t) || !/^\d{4}-/.test(s) ? undefined : new Date(t).toISOString();
};
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * A RETURNING value (`to_jsonb(row)`, parsed) in the read's wire form (`sql.ts` `wire`), or `undefined` when it cannot be
 * exact. A commit's image carries `numeric` as text (`commit.ts` `numericText`), so a decimal, money or sum keeps its
 * scale; a JSON number (an approval seal's or restore's image) has lost it (`1.20` → 1.2) and falls back to a PK get.
 */
function wireOf(f: FieldInfo, v: Json | undefined): Json | undefined {
	if (v === undefined || v === null) return v;
	switch (f.pg) {
		case 'numeric': return typeof v === 'string' ? { $dec: v } : undefined;
		case 'timestamptz': { const t = typeof v === 'string' ? iso(v) : undefined; return t === undefined ? undefined : { $t: t }; }
		case 'date': return typeof v === 'string' ? { $d: v } : undefined;
		case 'vector': return typeof v === 'string' ? JSON.parse(v) as Json : v;
		case 'point': {
			const p = typeof v === 'string' ? /^\(([^,]+),([^)]+)\)$/.exec(v) : null;
			return p === null ? undefined : { lat: Number(p[2]), lng: Number(p[1]) };
		}
		case 'daterange': {
			const p = typeof v === 'string' ? /^\[(\d{4}-\d\d-\d\d),(\d{4}-\d\d-\d\d)?\)$/.exec(v) : null;
			return p === null ? undefined : jb({ from: { $d: p[1]! }, to: p[2] === undefined ? null : { $d: dayBefore(p[2]) } });
		}
		case 'tstzrange': {
			const p = typeof v === 'string' ? /^[[(]"([^"]+)",(?:"([^"]+)")?[\])]$/.exec(v) : null;
			const start = p === null ? undefined : iso(p[1]!), end = p?.[2] === undefined ? null : iso(p[2]);
			return start === undefined || end === undefined ? undefined : jb({ start: { $t: start }, end: end === null ? null : { $t: end } });
		}
		default: return v;
	}
}
/** A wire value as the order compares it: `undefined` when the row does not carry it; a mask reads as null (`sql.ts` `col`). */
function sortable(v: Json | undefined): string | number | boolean | null | undefined {
	if (v === undefined || v === null) return v;
	if (typeof v !== 'object') return v;
	if (Array.isArray(v)) return undefined;
	const o = v as { readonly [k: string]: Json };
	if ('$masked' in o) return null;
	const t = o['$t'] ?? o['$d'] ?? o['$dec'];
	if (typeof t !== 'string') return undefined;
	return '$t' in o ? Date.parse(t) : '$dec' in o ? Number(t) : t;
}

export function liveHub(config: LiveConfig) {
	const cat = catalogOf(config.manifest);
	// an envoy declared `public` serves anyone, so its threads are in every member's list (the `conversations` read)
	const publicEnvoys = () => Object.entries(config.manifest.envoys ?? {}).filter(([, e]) => (e as { audience?: unknown }).audience === 'public').map(([n]) => n);
	const conns = new Map<string, Conn>();
	// `v`: the last commit's sequence; `routed`: the last one whose views were answered (frames are stamped with it)
	let v = 0, routed = 0, retained = 0, conservative = 0, n = 0, reads = 0;
	let pending: Captured[] = [], queued = false, chain = Promise.resolve();

	/** Rule 64: a clock view states `every`; a collection query states `every` or `on`; a cursor page or `similar` is not liveable. */
	function check(view: LiveView): void {
		const r = view.read;
		if (r.kind === 'similar' || r.kind === 'after' || (r.kind === 'read' && 'after' in r.page && r.page.after !== undefined))
			throw new BoltError('invalid', 'decode', `a ${r.kind === 'read' ? 'cursor page' : r.kind} read is not liveable`);
		if (view.every === undefined && (CLOCK.test(JSON.stringify(r)) || (r.kind === 'query' && view.on === undefined)))
			throw new BoltError('invalid', 'decode', r.kind === 'query' ? 'a live collection query states every or on' : 'a live read of now or today states every');
		if (view.every !== undefined && offsetMs(`+${view.every}`) < 1_000) throw new BoltError('invalid', 'decode', 'every is at least 1s');
	}

	/** The RETURNING image with each exclusive arc also under its field name as a `RecordRef`, as the evaluator and the wire read it. */
	const images = new WeakMap<RowData, RowData>();
	function image(collection: string, row: RowData): RowData {
		const hit = images.get(row);
		if (hit !== undefined) return hit;
		let out: { [k: string]: Json } | null = null;
		for (const f of cat.models.get(collection)?.fields.values() ?? []) {
			if (f.arms === undefined || f.arms.some((a) => row[`${f.column}__${a}`] === undefined)) continue;
			const arm = f.arms.find((a) => row[`${f.column}__${a}`] !== null);
			(out ??= { ...row })[f.name] = arm === undefined ? null : jb({ collection: arm, id: row[`${f.column}__${arm}`]! });
		}
		images.set(row, out ?? row);
		return out ?? row;
	}
	/** Whether a row image is one of the view's rows for this caller: a read arm admits it and the view's `where` holds. */
	function member(a: Authority, r: { collection: string; where?: Pred }, row: RowData, b: Bindings): boolean {
		const arms = a.admin ? null : a.collections[r.collection]?.read ?? [];
		const env: EvalEnv = { cat, bindings: b, authority: a, scoped: true };
		return (arms === null || arms.some((x) => evaluate({ ...env, scoped: false }, r.collection, x.where, row))) && (r.where === undefined || evaluate(env, r.collection, r.where, row));
	}

	/** What a captured row means for a view: skip, a decided hit, or undecidable. */
	function decide(a: Authority, view: View, c: Captured, b: Bindings): 'skip' | 'hit' | 'unknown' {
		const r = view.read;
		if (r.kind === 'query') return view.on?.includes(c.collection) ? 'hit' : 'skip';
		if (r.kind === 'transcript') return c.collection === r.collection && (c.new ?? c.old)?.['conversation'] === r.conversation
			&& (r.from === undefined || Number((c.new ?? c.old)?.['seq']) >= r.from) ? 'hit' : 'skip';
		if (r.kind === 'inbox') return c.collection === r.collection && (c.new ?? c.old)?.['member'] === r.member ? 'hit' : 'skip';
		if (r.kind === 'conversations') return c.collection === r.collection && listed(c.new ?? c.old, r.member, publicEnvoys()) ? 'hit' : 'skip';
		if (r.kind === 'similar' || r.kind === 'after') return 'unknown';
		// a commit to a related sort key's target (a renamed account) may reorder rows it does not carry: re-read
		if (r.kind === 'read' && sortTargets(cat, r.collection, r.order).has(c.collection)) return 'unknown';
		if (c.collection !== r.collection) return (r.kind === 'read' || r.kind === 'get') && targets(cat, r.select).has(c.collection) ? 'unknown' : 'skip';
		if (r.kind === 'get' || r.kind === 'history') return c.id === r.id ? 'hit' : 'skip';
		const arms = a.admin ? null : a.collections[c.collection]?.read ?? [];
		if ((r.where !== undefined && !decidable(r.where)) || arms?.some((x) => !decidable(x.where))) return 'unknown';
		const hit = (row: RowData | null) => row !== null && member(a, r, image(c.collection, row), b);
		try {
			return hit(c.old) || hit(c.new) ? 'hit' : 'skip';
		} catch {
			return 'unknown'; // a mask over a relation, a field the image does not carry
		}
	}

	/** A row image as the read projects it (`sql.ts` `items`): `id`, the selected fields in wire form, a mask as `$masked`;
	 * `undefined` when the image cannot give it exactly (a relation arm, an arc arm field, a numeric number, a column it lacks). */
	function project(a: Authority, collection: string, select: SelectIR, row: RowData, one: boolean, b: Bindings): Row | undefined {
		if (Object.keys(select.relations).length > 0) return undefined;
		const c = collectionOf(cat, collection);
		const out: { [k: string]: Json } = { id: row['id']! };
		for (const name of select.fields ?? defaultFields(c, one)) {
			if (name === 'id') continue;
			const f = c.model.fields.get(name);
			if (f === undefined || name.includes('.')) return undefined;
			const value = f.arms === undefined ? wireOf(f, row[f.column]) : row[name];
			if (value === undefined) return undefined;
			const mask = a.admin ? undefined : a.collections[collection]?.masks[name];
			out[name] = mask === undefined || evaluate({ cat, bindings: b, authority: a, scoped: false }, collection, mask, row) ? value : { $masked: true };
		}
		return jb(out);
	}

	function resolve(a: Authority, view: View, c: Captured, b: Bindings): Resolved {
		const r = view.read;
		if (r.kind === 'transcript') return { c, row: c.new === null ? null : transcriptRow(c.new as unknown as MessageRow, isStaff(a), r.thread) };
		if (r.kind === 'inbox') return { c, row: c.new === null ? null : noticeRow(c.new) };
		if (r.kind === 'conversations') return { c, row: c.new === null ? null : conversationRow(c.new) };
		if ((r.kind !== 'read' && r.kind !== 'get') || (r.kind === 'read' && r.search !== undefined)) return 'full';
		if (c.new === null) return { c, row: null };
		const row = image(c.collection, c.new);
		let project_: Row | undefined;
		try {
			if (!member(a, r.kind === 'get' ? { collection: r.collection } : r, row, b)) return { c, row: null };
			project_ = project(a, r.collection, r.select, row, r.kind === 'get', b);
		} catch {
			return 'full';
		}
		if (project_ !== undefined) return { c, row: project_ };
		// the one row, read as the view reads it (a list's default projection, not a record's)
		return r.kind === 'get' ? 'full' : { c, get: { kind: 'get', collection: r.collection, id: c.id,
			select: { fields: r.select.fields ?? defaultFields(collectionOf(cat, r.collection)), relations: r.select.relations } } };
	}

	/** Where `row` goes among `rows` by the view's order (nulls last ascending, first descending, then `id`), or `null` when
	 * it cannot be exact: a key the rows do not carry, or two different text values, whose order is the database collation's. */
	function place(r: Read | Own, rows: readonly Row[], row: Row): number | null {
		if (r.kind === 'transcript') {
			const at = rows.findIndex((x) => Number(x['seq']) > Number(row['seq']));
			return at < 0 ? rows.length : at;
		}
		if (r.kind === 'inbox' || r.kind === 'conversations') { // newest first, then id descending (the read's `COLLATE "C"`)
			const t = Date.parse(String(row['at'])), id = String(row['id']);
			const at = rows.findIndex((x) => { const u = Date.parse(String(x['at'])); return u < t || (u === t && String(x['id']) < id); });
			return at < 0 ? rows.length : at;
		}
		const fields = collectionOf(cat, r.collection).model.fields;
		const keys = [...r.order ?? [], { field: 'id', dir: 'asc' as const }];
		const before = (x: Row, y: Row): boolean | null => {
			for (const k of keys) {
				// a distance is the database's to compute: a row that moves re-reads
				if ('near' in k && k.near !== undefined) return null;
				const p = sortable(x[k.field]), q = sortable(y[k.field]);
				if (p === undefined || q === undefined) return null;
				if (p === q) continue;
				if (p === null || q === null) return (p === null) === (k.dir === 'desc');
				if (fields.get(k.field)?.pg === 'text') return null; // ponytail: collation-ordered text re-reads; learn the collation to place it
				return (p < q) === (k.dir === 'asc');
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
	function kept(r: Read | Own, a: Authority, c: Captured, old: Row, row: Row): boolean {
		if (r.kind === 'transcript') return old['seq'] === row['seq'];
		if (r.kind === 'inbox' || r.kind === 'conversations') return old['at'] === row['at'];
		const fields = collectionOf(cat, r.collection).model.fields;
		return (r.order ?? []).every(({ field }) => {
			// a related key (`account.name`) holds while its relation does; a commit to the target re-reads (`decide`)
			const head = field.split('.')[0]!, col = fields.get(head)?.column ?? head;
			return c.old !== null && c.new !== null && (a.admin || a.collections[r.collection]?.masks[head] === undefined) && same(c.old[col], c.new[col] ?? null);
		});
	}

	/** Applies one resolved row to a working value; the ops that did it, or `'full'` when only a re-read is exact. */
	function apply(a: Authority, view: View, work: { value: Json }, c: Captured, row: Row | null): PatchOp[] | 'full' {
		const r = view.read;
		if (r.kind === 'get') {
			if (row === null) return work.value === null ? [] : (work.value = null, [{ op: 'remove', id: c.id }]);
			if (same(work.value, row)) return [];
			work.value = row;
			return [{ op: 'upsert', index: 0, row }];
		}
		const page = work.value as Page;
		if ((r.kind !== 'read' && r.kind !== 'transcript' && r.kind !== 'inbox' && r.kind !== 'conversations') || !Array.isArray(page?.rows)) return 'full';
		const rows = page.rows, i = rows.findIndex((x) => x['id'] === c.id);
		const more = page.next !== undefined && page.next !== null;
		const limit = r.kind === 'read' && 'limit' in r.page ? r.page.limit : r.kind === 'inbox' ? INBOX_LIMIT : r.kind === 'conversations' ? CONVERSATIONS : LIMITS.page.all;
		if (row === null) {
			if (more) return 'full'; // a row left: from the page, which backfills; or from beyond it, which may end `next`
			if (i < 0) return [];
			rows.splice(i, 1);
			return [{ op: 'remove', id: c.id }];
		}
		if (i >= 0 && kept(r, a, c, rows[i]!, row)) {
			if (same(rows[i], row)) return [];
			rows[i] = row;
			return [{ op: 'upsert', index: i, row }];
		}
		const last = rows.at(-1)?.['id'];
		if (i >= 0) rows.splice(i, 1);
		const at = place(r, rows, row);
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
	function put(conn: Conn, view: View, value: Json, ops?: readonly PatchOp[]): void {
		const text = JSON.stringify(value);
		if (ops === undefined && view.value !== undefined && text === JSON.stringify(view.value)) return;
		const bytes = bytesOf(text);
		const over: [LiveErrorCode, string] | null = bytes > LIVE.subscriptionBytes ? ['subscriptionTooLarge', `the answer is ${bytes} bytes; a live view holds at most ${LIVE.subscriptionBytes}`]
			: retained - view.bytes + bytes > LIVE.cellBytes ? ['cellBudget', `the cell retains at most ${LIVE.cellBytes} bytes of live answers`] : null;
		if (over !== null) {
			drop(conn, view.id);
			conn.send({ t: 'error', view: view.id, code: over[0], message: over[1] });
			return;
		}
		retained += bytes - view.bytes;
		view.bytes = bytes;
		view.value = value;
		conn.send(ops === undefined ? { t: 'answer', view: view.id, v: routed, value } : { t: 'patch', view: view.id, v: routed, ops });
	}
	const failed = (conn: Conn, view: View, err: unknown) =>
		conn.send({ t: 'error', view: view.id, code: err instanceof BoltError ? err.code : 'internal', message: err instanceof Error ? err.message : String(err) });

	/** One pipelined read; a failing batch is re-asked per read so one bad view errors alone. */
	async function readAll(conn: Conn, batch: readonly ReadIR[], b: Bindings): Promise<readonly Answer[]> {
		if (batch.length === 0) return [];
		reads += batch.length;
		try {
			return (await config.read(batch, conn.authority, b)).map((ok) => ({ ok }));
		} catch {
			return Promise.all(batch.map((x) => config.read([x], conn.authority, b).then((r): Answer => ({ ok: r[0]! }), (err: unknown): Answer => ({ err }))));
		}
	}
	async function answer(conn: Conn, views: readonly View[]): Promise<void> {
		const values = await readAll(conn, views.map((x) => x.read), config.bindings());
		views.forEach((view, i) => {
			if (!conn.views.has(view.id)) return;
			const r = values[i]!;
			if ('ok' in r) put(conn, view, r.ok);
			else failed(conn, view, r.err);
		});
	}

	function drop(conn: Conn, id: string): void {
		const view = conn.views.get(id);
		if (view === undefined) return;
		clearTimeout(view.timer);
		clearInterval(view.timer);
		retained -= view.bytes;
		conn.views.delete(id);
	}

	function disconnect(id: string): void {
		const conn = conns.get(id);
		if (conn === undefined) return;
		for (const view of [...conn.views.keys()]) drop(conn, view);
		conns.delete(id);
	}

	async function flush(): Promise<void> {
		queued = false;
		routed = v;
		const batch = pending;
		pending = [];
		const b = config.bindings();
		let hit = 0, patched = 0, fallback = 0;
		reads = 0;
		await Promise.all([...conns.values()].map(async (conn) => {
			const full: View[] = [], deltas: { view: View; rows: Exclude<Resolved, 'full'>[] }[] = [];
			for (const view of conn.views.values()) {
				const hits: Captured[] = [];
				let unsure = false;
				for (const c of batch) {
					const d = decide(conn.authority, view, c, b);
					if (d === 'unknown') unsure = true;
					else if (d === 'hit') hits.push(c);
				}
				if (!unsure && hits.length === 0) continue;
				hit++;
				if (view.read.kind === 'query') {
					// a collection query re-runs debounced, shared by nothing else on this connection
					view.timer ??= setTimeout(() => { view.timer = undefined; void answer(conn, [view]); }, LIVE.onDebounceMs);
					continue;
				}
				const rows = unsure || view.value === undefined ? ['full' as const] : hits.map((c) => resolve(conn.authority, view, c, b));
				if (rows.includes('full')) full.push(view);
				else deltas.push({ view, rows: rows as Exclude<Resolved, 'full'>[] });
			}
			// the fallbacks, in one round trip: whole views, then single rows by id
			const gets = deltas.flatMap((d) => d.rows.flatMap((x) => 'get' in x ? [x.get] : []));
			const values = await readAll(conn, [...full.map((x) => x.read), ...gets], b);
			full.forEach((view, i) => {
				const r = values[i]!;
				if (conn.views.has(view.id)) { if ('ok' in r) put(conn, view, r.ok); else failed(conn, view, r.err); }
			});
			let k = full.length;
			const again: View[] = [];
			for (const { view, rows } of deltas) {
				const got = rows.map((x) => 'get' in x ? values[k++]! : null);
				if (!conn.views.has(view.id)) continue;
				if (got.some((x) => x !== null)) { fallback++; view.conservative = true; }
				const value = view.value as Json;
				const work = { value: Array.isArray((value as Page | null)?.rows) ? { ...(value as Page), rows: [...(value as Page).rows] } as Json : value };
				const ops: PatchOp[] = [];
				let exact = true;
				for (const [i, x] of rows.entries()) {
					const g = got[i];
					if (g !== null && g !== undefined && 'err' in g) { exact = false; break; }
					const o = apply(conn.authority, view, work, x.c, 'row' in x ? x.row : (g as { ok: Json }).ok as Row | null);
					if (o === 'full') { exact = false; break; }
					ops.push(...o);
				}
				if (!exact) { again.push(view); continue; }
				if (ops.length === 0) continue;
				patched++;
				put(conn, view, work.value, ops);
			}
			for (const view of [...full, ...again]) view.conservative = true;
			fallback += full.length + again.length;
			await answer(conn, again); // rare: a page boundary moved or an order needed the collation
			conn.send({ t: 'v', v: routed });
		}));
		conservative += fallback;
		config.log?.(`live v=${routed} rows=${batch.length} views=${hit} patched=${patched} conservative=${fallback} reads=${reads}`);
	}

	return {
		/** The lane sequence of the last commit. */
		get v() { return v; },
		connect(authority: Authority, send: (frame: Frame) => void, end: () => void): string {
			const id = `c${++n}`;
			conns.set(id, { id, authority, send, end, views: new Map() });
			send({ t: 'hello', conn: id, v: routed });
			return id;
		},
		/** The authority a connection reads with, or `undefined` when it is gone. */
		authorityOf: (conn: string) => conns.get(conn)?.authority,
		disconnect,
		/** Registers a view and sends its first answer; a refusal throws and leaves the stream as it was. */
		async register(connId: string, id: string, view: LiveView): Promise<void> {
			const conn = conns.get(connId);
			if (conn === undefined) throw new BoltError('notFound', 'admission', 'the live connection is gone');
			check(view);
			if (!conn.views.has(id) && conn.views.size >= LIVE.perConnection)
				throw new BoltError('tooManySubscriptions', 'admission', `a connection holds at most ${LIVE.perConnection} live views`);
			drop(conn, id);
			const state: View = { ...view, id, bytes: 0, value: undefined };
			conn.views.set(id, state);
			if (view.every !== undefined) state.timer = setInterval(() => void answer(conn, [state]), offsetMs(`+${view.every}`));
			await answer(conn, [state]);
		},
		drop(connId: string, id: string): void {
			const conn = conns.get(connId);
			if (conn !== undefined) drop(conn, id);
		},
		/** Rule 66: routes one commit's RETURNING set; returns the lane sequence the act replies with. */
		publish(captured: readonly Captured[]): number {
			if (captured.length === 0) return v;
			pending.push(...captured);
			v++;
			if (!queued) {
				queued = true;
				chain = chain.then(flush, flush);
			}
			return v;
		},
		/** Resolves when every published commit has been routed. */
		settled: () => chain,
		/** Rule 66: an authority change re-answers the connection's views. */
		async authorize(connId: string, authority: Authority): Promise<void> {
			const conn = conns.get(connId);
			if (conn === undefined) return;
			conn.authority = authority;
			for (const view of conn.views.values()) view.value = undefined;
			await answer(conn, [...conn.views.values()]);
		},
		/** Rule 66: a generation change closes every connection with `{ release }`. */
		close(release: string): void {
			for (const conn of [...conns.values()]) {
				conn.send({ t: 'close', release });
				disconnect(conn.id);
				conn.end();
			}
		},
		/** Views answered by a fallback read (undecidable, or a delta that could not be exact), and the running count. */
		sweep: () => ({ conservative, views: [...conns.values()].flatMap((c) => [...c.views.values()].filter((x) => x.conservative).map((x) => `${c.id}/${x.id}`)) }),
		retained: () => retained,
	};
}
