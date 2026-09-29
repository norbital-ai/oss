// `$bolt` (§3.5, rules 64–67): reads as thenables (`await q` once, `live(q)` while rendered), acts that never reject,
// optimistic paint settled by the outcome, and read-your-writes on the lane sequence. The generated alias narrows the
// names and rows per workspace; this runtime is name-erased.
import type { FileRef, Json } from '../decl/values.ts';
import type { Live, LiveError, Q } from '../decl/ctx.ts';
import type { Outcome } from '../engine/contracts.ts';
import type { ApprovalView } from '../engine/approvals/approvals.ts';
import { HEADERS, PATHS, uuidv7, type ActBody, type ActReply, type Frame, type LiveBody, type LiveReply, type PatchOp, type QReply, type WireError, type WireRead } from '../protocol/wire.ts';
import { liveStream, type EventSourceLike, type Signals } from './stream.ts';
import { browserCatalog, type BrowserCatalog, type Catalog } from '../protocol/catalog.ts';
import { decodeView } from '../protocol/ir.ts';
import { Decimal } from '@norbital-ai/std/decimal';

export type { Live, LiveError, Q };
export type RunHandle = PromiseLike<Outcome> & { readonly id: string };
export type BoltConfig = {
	actor: Json; locale: string; messages?: { readonly [key: string]: string };
	base?: string; fetch?: typeof fetch; openStream?: (url: string) => EventSourceLike; signals?: Signals;
	uuid?: () => string; now?: () => string;
	/** The caller's collections as the shell boot states them: `decode` checks filters and sorts against it (rule 11a). */
	catalog?: BrowserCatalog;
	/** The host binds the AI facility: `describe` exists (rule 16a); without it the view popover hides the input (P35). */
	describe?: boolean;
	/** The schema the page was booted against, sent as `Bolt-Contract` on every act (L-BOLT-171). */
	contract?: string;
};
type Row = { readonly [field: string]: Json };
type Paint = { collection: string; apply(value: Json, m: WireRead['m']): Json };
/** `server`: the view's value as the stream last stated it, at lane sequence `v`. */
type View = { id: string; key: string; read: WireRead; every?: string; on?: readonly string[]; server: Json | undefined; v: number; error: LiveError | undefined;
	readers: Set<(value: Json | undefined) => void>; grace?: ReturnType<typeof setTimeout>; registered: boolean };

/**
 * An answer as pages hold it (§3.3.10): a date and an instant are std's branded ISO strings, a decimal is std's
 * `Decimal` (branded, so `instanceof` holds for any std copy a page or template bundle imports).
 */
export function typed(v: Json): Json {
	if (Array.isArray(v)) return v.map(typed);
	if (!isRow(v)) return v;
	const keys = Object.keys(v);
	if (keys.length === 1 && (keys[0] === '$d' || keys[0] === '$t') && typeof v[keys[0]] === 'string') return v[keys[0]]!;
	if (keys.length === 1 && keys[0] === '$dec' && typeof v['$dec'] === 'string') {
		return Decimal.of(v['$dec']) as unknown as Json;
	}
	return Object.fromEntries(keys.map((k) => [k, typed(v[k]!)]));
}

/** Rule 64: a view outlives its last reader by 30 s. Rule 66: an act waits at most 5 s for its commit on the stream. */
export const GRACE_MS = 30_000, CATCH_UP_MS = 5_000;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = <T>(x: T | readonly T[]): readonly T[] => Array.isArray(x) ? x : [x as T];
const RELATION_OPS = ['create', 'update', 'delete', 'upsert', 'link', 'unlink'];
const PAINTED = new Set(['create', 'update', 'delete']);

/** Rule 65: a patch applied to a view's value (a page's `rows`, or a `get`'s row); `undefined` when it does not fit it. */
export function patched(value: Json | undefined, ops: readonly PatchOp[]): Json | undefined {
	if (value === undefined) return undefined;
	const page = isRow(value) && Array.isArray(value['rows']) ? value : null;
	let rows: Json[] = page === null ? (value === null ? [] : [value]) : [...page['rows'] as Json[]];
	for (const o of ops) {
		rows = rows.filter((r) => !isRow(r) || r['id'] !== (o.op === 'remove' ? o.id : isRow(o.row) ? o.row['id'] : null));
		if (o.op === 'upsert') {
			if (o.index > rows.length) return undefined;
			rows.splice(o.index, 0, o.row);
		}
	}
	if (page !== null) return { ...page, rows };
	return rows.length > 1 ? undefined : rows[0] ?? null;
}

/** The paint of one generated write over the live reads of its collection (rule 67); actions and queries do not paint. */
function paintOf(collection: string, verb: string, input: Json, key: string): Paint {
	const rows = (v: Json, m: WireRead['m'], each: (rows: readonly Row[]) => readonly Row[]): Json =>
		m === 'read' && isRow(v) && Array.isArray(v['rows']) ? { ...v, rows: each(v['rows'] as Row[]) as Json } : m === 'get' && isRow(v) ? each([v])[0] ?? null : v;
	if (verb === 'create') {
		const created = list(input).map((x, i): Row => ({ id: `pending:${key}:${i}`, ...(isRow(x) ? x : {}) }));
		return { collection, apply: (v, m) => m === 'read' ? rows(v, m, (rs) => [...created, ...rs]) : v };
	}
	if (verb === 'delete') {
		const gone = new Set(list((isRow(input) ? input['target'] : null) as Json).map(String));
		return { collection, apply: (v, m) => rows(v, m, (rs) => rs.filter((r) => !gone.has(String(r['id'])))) };
	}
	const sets = new Map<string, Row>();
	for (const x of list(input)) if (isRow(x) && isRow(x['set'])) {
		// a nested relation op is painted by its own rows' views, never merged as a field
		const set = Object.fromEntries(Object.entries(x['set']).filter(([, v]) => !(isRow(v) && Object.keys(v).some((k) => RELATION_OPS.includes(k)))));
		for (const id of list(x['target'] as Json)) sets.set(String(id), set);
	}
	return { collection, apply: (v, m) => rows(v, m, (rs) => rs.map((r) => sets.has(String(r['id'])) ? { ...r, ...sets.get(String(r['id'])) } : r)) };
}

export function createBolt(config: BoltConfig) {
	const base = config.base ?? '';
	const f = config.fetch ?? ((input, init) => fetch(input, init));
	const uuid = config.uuid ?? (() => uuidv7()); // hook:protocol — rule 24: caller-minted ids are uuidv7
	const now = config.now ?? (() => new Date().toISOString());
	const views = new Map<string, View>();
	let decoder: Catalog | undefined;
	const paints = new Set<Paint>();
	/** The client ledger: the revision of every row this page last read (rule 25). */
	const revisions = new Map<string, number>();
	const waiters = new Set<{ v: number; done(): void }>();
	let conn: string | null = null, applied = 0, n = 0;
	let closed: string | null = null;
	/** L-BOLT-499: the link's state for the shell's banner; `closed` once a release closed the stream (rule 66). */
	const statusReaders = new Set<(s: SyncStatus) => void>();
	const syncStatus = (): SyncStatus => closed !== null ? 'closed' : conn !== null ? 'live' : stream.open || stream.retrying ? 'connecting' : 'idle';
	const emitStatus = () => { const now = syncStatus(); for (const run of statusReaders) run(now); };

	async function post<T>(path: string, body: unknown, headers: { readonly [h: string]: string } = {}): Promise<{ status: number; body: T | WireError }> {
		const res = await f(`${base}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
		return { status: res.status, body: await res.json() as T | WireError };
	}
	const fail = (e: WireError, status: number) => Object.assign(new Error(e.error.message), { code: e.error.code, status });
	const track = (v: Json | undefined) => {
		for (const r of Array.isArray(v) ? v : isRow(v) && Array.isArray(v['rows']) ? v['rows'] : [v ?? null])
			if (isRow(r) && typeof r['id'] === 'string' && typeof r['revision'] === 'number') revisions.set(r['id'], r['revision']);
	};
	const shown = (s: View): Json | undefined => {
		let v = s.server;
		if (v === undefined) return v;
		for (const p of paints) if (p.collection === s.read.a[0]) v = p.apply(v, s.read.m);
		return v;
	};
	const notify = (s: View) => { const v = shown(s); for (const run of s.readers) run(v); };
	const repaint = (collection: string) => { for (const s of views.values()) if (s.read.a[0] === collection) notify(s); };

	// ── the stream ──
	const advance = (v: number) => {
		applied = Math.max(applied, v);
		for (const w of waiters) if (applied >= w.v) w.done();
	};
	// the browser's two link signals: `document.hidden` is typed, `window` is what fires `online` (neither `Window` nor
	// `globalThis` declares both), so the client's one view of them is this pair
	const signals: Signals | undefined = typeof document === 'undefined' ? undefined : {
		get hidden() { return document.hidden; },
		addEventListener: (type, run) => { window.addEventListener(type, run); },
	};
	const stream = liveStream(() => config.openStream?.(`${base}${PATHS.live}`) ?? new EventSource(`${base}${PATHS.live}`, { withCredentials: true }), onFrame, () => {
		conn = null;
		emitStatus();
		for (const s of views.values()) s.registered = false;
		for (const w of waiters) w.done();
	}, config.signals ?? signals);

	async function register(add: readonly View[], drop: readonly string[] = []): Promise<void> {
		if (conn === null || (add.length === 0 && drop.length === 0)) return;
		for (const s of add) s.registered = true;
		const body: LiveBody = { conn, drop, add: add.map((s) => ({ view: s.id, read: s.read, ...(s.every === undefined ? {} : { every: s.every }), ...(s.on === undefined ? {} : { on: s.on }) })) };
		let reply: LiveReply | WireError;
		try {
			reply = (await post<LiveReply>(PATHS.live, body)).body;
		} catch {
			for (const s of add) s.registered = false; // the next `hello` registers it again
			return;
		}
		const errors = 'error' in reply ? add.map((s) => ({ view: s.id, ...(reply as WireError).error })) : reply.errors;
		for (const e of errors) {
			const s = views.get(e.view);
			if (s !== undefined) { s.error = { code: e.code, message: e.message }; notify(s); }
		}
	}

	function onFrame(frame: Frame): void {
		const s = 'view' in frame ? views.get(frame.view) : undefined;
		switch (frame.t) {
			case 'hello':
				conn = frame.conn;
				emitStatus();
				applied = frame.v;
				for (const x of views.values()) x.registered = false;
				void register([...views.values()]);
				return;
			case 'answer':
				if (s !== undefined) { s.server = typed(frame.value); s.v = frame.v; s.error = undefined; track(frame.value); notify(s); }
				return advance(frame.v);
			case 'patch': {
				if (s === undefined || frame.v <= s.v) return advance(frame.v); // a patch the view's answer already holds
				const next = patched(s.server, frame.ops.map((o) => o.op === 'upsert' ? { ...o, row: typed(o.row) } : o));
				if (next === undefined) { s.registered = false; void register([s]); return; } // out of step: re-register, which answers
				s.server = next;
				s.v = frame.v;
				for (const o of frame.ops) if (o.op === 'upsert') track(o.row);
				notify(s);
				return advance(frame.v);
			}
			case 'error':
				if (s !== undefined) { s.error = { code: frame.code, message: frame.message }; s.registered = false; notify(s); }
				return;
			case 'v': return advance(frame.v);
			case 'close':
				closed = frame.release;
				emitStatus();
				return stream.want(false);
		}
	}

	/** Rule 66: resolves once the stream has applied `v`, at most 5 s, and at once when no stream is open. */
	const caughtUp = (v: number) => new Promise<void>((resolve) => {
		if (applied >= v || !stream.open) return resolve();
		const w = { v, done() { clearTimeout(timer); waiters.delete(w); resolve(); } };
		const timer = setTimeout(w.done, CATCH_UP_MS);
		waiters.add(w);
	});

	// ── reads ──
	async function once(read: WireRead): Promise<Json> {
		const { status, body } = await post<QReply>(PATHS.q, { reads: [read] });
		if ('error' in body) throw fail(body, status);
		// a past revision (`get(c, id, …, { revision })`) is history, not what this page last read (rule 25)
		if (!(read.m === 'get' && isRow(read.a[2]) && read.a[2]['revision'] !== undefined)) track(body.answers[0]);
		return typed(body.answers[0]!);
	}
	const q = <T>(m: WireRead['m'], a: readonly unknown[]): Q<T> => {
		const read = { m, a: a.filter((x) => x !== undefined) as Json[] };
		return { read, then: (ok, bad) => (once(read) as Promise<T>).then(ok, bad) };
	};

	function live<T>(query: Q<T>, options: { every?: string; on?: readonly string[] } = {}): Live<T> {
		const key = JSON.stringify([query.read, options.every ?? null, options.on ?? null]);
		let found: View | undefined;
		for (const s of views.values()) if (s.key === key) found = s;
		const s: View = found ?? { id: `v${++n}`, key, read: query.read, ...options, server: undefined, v: 0, error: undefined, readers: new Set(), registered: false };
		return {
			get current() { return shown(s) as T | undefined; },
			get error() { return s.error; },
			subscribe(run) {
				clearTimeout(s.grace);
				s.readers.add(run as (value: Json | undefined) => void);
				if (!views.has(s.id)) {
					views.set(s.id, s);
					stream.want(true);
				}
				if (!s.registered) void register([s]);
				run(shown(s) as T | undefined);
				return () => {
					s.readers.delete(run as (value: Json | undefined) => void);
					if (s.readers.size > 0) return;
					s.grace = setTimeout(() => {
						views.delete(s.id);
						if (s.registered) void register([], [s.id]);
						s.registered = false;
						if (views.size === 0) stream.want(false);
					}, GRACE_MS);
				};
			},
		};
	}

	// ── acts: never reject (rule 32) ──
	async function send(callable: string, input: Json, key: string, observed?: { [id: string]: number }): Promise<Outcome> {
		try {
			const body: ActBody = { callable, input, issuedAt: now(), ...(observed === undefined ? {} : { observed }) };
			const { status, body: reply } = await post<ActReply>(PATHS.act, body, { [HEADERS.key]: key, ...(config.contract === undefined ? {} : { [HEADERS.contract]: config.contract }) });
			if ('error' in reply) {
				const code = status === 400 ? 'invalidInput' : status === 401 || status === 403 ? 'forbidden' : status === 404 ? 'notFound' : status === 429 ? 'rateLimited' : null;
				return code === null ? { kind: 'unknown', invocation: key } : { kind: 'refused', code, message: reply.error.message };
			}
			if (reply.outcome.kind === 'committed' || reply.outcome.kind === 'pendingApproval') await caughtUp(reply.v);
			return reply.outcome;
		} catch {
			return { kind: 'unknown', invocation: key };
		}
	}

	async function act(callable: string, input: Json, options: { key?: string } = {}): Promise<Outcome> {
		const dot = callable.lastIndexOf('.');
		const collection = callable.slice(0, dot), verb = callable.slice(dot + 1);
		const key = options.key ?? uuid();
		let observed: { [id: string]: number } | undefined;
		if (verb === 'update' || verb === 'delete') for (const x of list(input)) for (const id of list((isRow(x) ? x['target'] : null) as Json)) {
			const r = revisions.get(String(id));
			if (r !== undefined) (observed ??= {})[String(id)] = r;
		}
		// committed and held rows are on the stream before the paint lifts; a refusal or conflict lifts it at once
		const paint = PAINTED.has(verb) ? paintOf(collection, verb, input, key) : null;
		if (paint !== null) { paints.add(paint); repaint(collection); }
		try {
			return await send(callable, input, key, observed);
		} finally {
			if (paint !== null) { paints.delete(paint); repaint(collection); }
		}
	}

	return {
		read: <T = { rows: Row[]; next: string | null }>(collection: string, options: Json) => q<T>('read', [collection, options]),
		/** `{ revision }`: the record as of that revision, folded from its history (L-BOLT-181); `select` does not narrow it. */
		get: <T = Row | null>(collection: string, id: string, select?: Json, options: { revision?: number } = {}) =>
			q<T>('get', [collection, id, select === undefined && options.revision === undefined ? undefined
				: { ...(select === undefined ? {} : { select }), ...(options.revision === undefined ? {} : { revision: options.revision }) }]),
		aggregate: <T = Row[]>(collection: string, options: Json) => q<T>('aggregate', [collection, options]),
		/** The named form (§3.3.4): `similar(c, '<search>', input, { where?, select?, limit })`; `similar(c, { to, … })` over `search.semantic`. */
		similar: <T = Row[]>(collection: string, search: string | Json, input?: Json, options?: Json) =>
			q<T>('similar', typeof search === 'string' ? [collection, search, input ?? null, options ?? {}] : [collection, search]),
		history: <T = Json>(collection: string, id: string, options: { at?: Json } = {}) => q<T>('history', [collection, id, options.at ?? undefined]),
		query: <T = Json>(name: string, input: Json) => q<T>('query', [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.') + 1), input]),
		live,
		act,
		/** Rule 11a in the browser: a filter and sort from the URL or the view popover, each top-level condition and sort key
		 * kept or dropped alone (rule 16b); the host decodes again regardless. */
		decode(collection: string, view: { where?: Json; orderBy?: Json }) {
			if (config.catalog === undefined) throw new Error('This client has no catalog to decode against.');
			return decodeView(decoder ??= browserCatalog(config.catalog), collection, view);
		},
		/** Rule 16a `filter.describe` as the caller: a description → `{ where, orderBy? }`; rejects when no filter could be built. */
		...(config.describe === true ? { async describe(collection: string, text: string, fields?: readonly { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean }[]): Promise<{ where: Json; orderBy?: Json }> {
			const o = await send('filter.describe', { collection, text, ...(fields === undefined ? {} : { fields }) }, uuid());
			if (o.kind !== 'committed') throw new Error(o.kind === 'refused' ? o.message : 'Could not build a filter from that description.');
			return o.output as { where: Json; orderBy?: Json };
		} } : {}),
		/** The client-minted run id is the key (rule 31). */
		start(automation: string, input: Json): RunHandle {
			const id = uuid();
			const outcome = send('start', { automation, input, id }, id);
			return { id, then: (ok, bad) => outcome.then(ok, bad) };
		},
		/** `accept` and `max` are checked before bytes are stored. */
		async upload(file: Blob & { name?: string }, field: string): Promise<FileRef> {
			const res = await f(`${base}${PATHS.files}${encodeURIComponent(field)}`, { method: 'PUT', credentials: 'same-origin', body: file,
				headers: { [HEADERS.key]: uuid(), 'content-type': file.type || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name ?? 'file')}` } });
			const body = await res.json() as FileRef | WireError;
			if ('error' in body) throw fail(body, res.status);
			return body;
		},
		fileUrl: (ref: FileRef) => `${base}${PATHS.files}${encodeURIComponent(ref.id)}`,
		/** Decide, withdraw or view an approval request (§3.8) as the caller. */
		approvals: {
			process: (requestId: string, decision: { status: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED'; reason?: string }) =>
				send('approvals.process', { requestId, ...decision }, uuid()),
			withdraw: (requestId: string) => send('approvals.withdraw', { requestId }, uuid()),
			/** The approval view (§3.8): the request, its flow and decisions, and what the viewer may do; `null` when not visible. */
			async get(requestId: string): Promise<ApprovalView | null> {
				const res = await f(`${base}${PATHS.approval}?id=${encodeURIComponent(requestId)}`, { credentials: 'same-origin' });
				if (res.status === 404) return null;
				const body = await res.json() as { value: ApprovalView } | WireError;
				if ('error' in body) throw fail(body, res.status);
				return body.value;
			},
		},
		actor: config.actor,
		/** The page's locale tag. */
		locale: config.locale,
		t: (key: string, vars: { readonly [name: string]: string | number } = {}) =>
			(config.messages?.[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => vars[name] === undefined ? m : String(vars[name])),
		/** The release that closed the stream (rule 66): the shell shows the reload notice. */
		get closed() { return closed; },
		/** `live` (the stream answers), `connecting` (opening, or retrying a drop), `idle` (no live read open) or
		 * `closed` (reload for the new release). */
		get syncStatus() { return syncStatus(); },
		/** Calls `run` with the status now and on every change; returns the unsubscribe. */
		onSyncStatus(run: (s: SyncStatus) => void): () => void { statusReaders.add(run); run(syncStatus()); return () => { statusReaders.delete(run); }; },
		/** Retire this client (a boot that replaces it): the stream closes, no view reopens it, and it stops reporting. */
		close: () => { statusReaders.clear(); stream.want(false); },
	};
}
export type Bolt = ReturnType<typeof createBolt>;
export type SyncStatus = 'idle' | 'connecting' | 'live' | 'closed';
