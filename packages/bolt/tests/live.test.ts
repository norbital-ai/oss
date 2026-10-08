// engine/live, protocol/wire and the $bolt client without a database: one guarantee per test (rules 32, 64–67).
import { describe, expect, it, vi } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import type { Authority, Captured, EngineActor, ReadIR } from '../src/engine/contracts.ts';
import { LIVE, liveHub } from '../src/engine/live/hub.ts';
import * as ir from '../src/protocol/ir.ts';
import { createBolt, type SyncStatus } from '../src/client/bolt.ts';
import { type EventSourceLike } from '../src/client/stream.ts';
import { redact, statusOf, type Frame, type LiveBody } from '../src/protocol/wire.ts';
import { manifest } from './engine-fixture.ts';

const cat = catalogOf(manifest);
const NOW = '2026-09-25T10:00:00.000Z';
const bindings = () => ({ now: NOW, today: '2026-09-25', tz: 'UTC', params: {} });
const member = (id: string): EngineActor => ({ kind: 'member', id, email: null, phone: null, external: false, teams: [], teamPath: [], admin: false, party: null });
const admin = compileAuthority(manifest, { actor: member('root'), policies: [], admin: true }, 'admin');
const rep = compileAuthority(manifest, { actor: member('u1'), policies: ['rep'], admin: false }, 'rep');
const order = (over: { [k: string]: Json } = {}) => ({ id: 'o1', title: 'desk', region: 'north', status: 'draft', created_by: 'u1', revision: 1, ...over });
const cap = (old: { [k: string]: Json } | null, next: { [k: string]: Json } | null, collection = 'orders'): Captured =>
	({ collection, id: String((next ?? old)!['id']), op: old === null ? 'create' : next === null ? 'delete' : 'update', revision: 1, old, new: next, cause: 'direct' });

/** A hub over a fake read that answers each view with a counter, so every re-answer is a new frame. */
function setup(answer: (read: ReadIR) => Json = () => null) {
	const asked: ReadIR[] = [];
	let n = 0;
	const hub = liveHub({ manifest, bindings, read: async (batch) => batch.map((r) => (asked.push(r), answer(r) ?? ++n)) });
	const frames: Frame[] = [];
	let ended = false;
	const connect = (a: Authority = admin) => hub.connect(a, (f) => frames.push(f), () => { ended = true; });
	return { hub, frames, asked, connect, ended: () => ended };
}
const answers = (frames: readonly Frame[]) => frames.flatMap((f) => f.t === 'answer' ? [f.view] : []);
const patches = (frames: readonly Frame[]) => frames.flatMap((f) => f.t === 'patch' ? [[f.view, f.ops] as const] : []);
const page = (...rows: Json[]) => ({ rows, next: null });

describe('engine/live: routing on pre- and post-images (rule 65)', () => {
	it('re-answers only the views a commit touches; an undecidable view is re-answered and counted', async () => {
		const { hub, frames, asked, connect } = setup((r) => r.kind === 'read' ? page() : null);
		const c = connect();
		const title = { title: true };
		await hub.register(c, 'submitted', { read: ir.read(cat, 'orders', { where: { status: { eq: 'submitted' } }, select: title, all: true }) });
		await hub.register(c, 'all', { read: ir.read(cat, 'orders', { select: title, all: true }) });
		await hub.register(c, 'other', { read: ir.get(cat, 'orders', 'o2') });
		await hub.register(c, 'byCustomer', { read: ir.read(cat, 'orders', { where: { customer: { is: { blocked: { eq: false } } } }, select: title, all: true }) });
		await hub.register(c, 'customers', { read: ir.read(cat, 'customers', { all: true }) });
		frames.length = 0;
		asked.length = 0;
		hub.publish([cap(null, order())]);
		await hub.settled();
		expect(patches(frames)).toEqual([['all', [{ op: 'upsert', index: 0, row: { id: 'o1', title: 'desk' } }]]]);
		expect(asked).toEqual([expect.objectContaining({ where: expect.objectContaining({ t: 'one' }) })]); // re-read; its answer did not change
		expect(hub.sweep()).toEqual({ conservative: 1, views: [`${c}/byCustomer`] });
	});

	it('a row leaving a view (pre-image in, post-image out) is removed from it', async () => {
		const { hub, frames, asked, connect } = setup(() => page({ id: 'o1', title: 'desk' }));
		const c = connect();
		await hub.register(c, 'drafts', { read: ir.read(cat, 'orders', { where: { status: { eq: 'draft' } }, select: { title: true }, all: true }) });
		frames.length = 0;
		asked.length = 0;
		hub.publish([cap(order(), order({ status: 'submitted' }))]);
		await hub.settled();
		expect(patches(frames)).toEqual([['drafts', [{ op: 'remove', id: 'o1' }]]]);
		expect(asked).toEqual([]);
	});

	it("a row outside the caller's read scope before and after is not routed to it", async () => {
		const { hub, frames, connect } = setup(() => page());
		const c = connect(rep);
		await hub.register(c, 'mine', { read: ir.read(cat, 'orders', { select: { title: true }, all: true }) });
		frames.length = 0;
		hub.publish([cap(null, order({ created_by: 'someone-else' }))]);
		await hub.settled();
		expect(patches(frames)).toEqual([]);
		hub.publish([cap(null, order({ id: 'o3' }))]);
		await hub.settled();
		expect(patches(frames).map(([view]) => view)).toEqual(['mine']);
	});

	it('commits coalesce per lane batch: one patch per view, no read, stamped with the batch sequence, then `v`', async () => {
		const { hub, frames, asked, connect } = setup(() => page());
		const c = connect();
		await hub.register(c, 'all', { read: ir.read(cat, 'orders', { select: { title: true }, all: true }) });
		asked.length = 0;
		frames.length = 0;
		expect([hub.publish([cap(null, order())]), hub.publish([cap(null, order({ id: 'o2' }))])]).toEqual([1, 2]);
		await hub.settled();
		expect(asked).toHaveLength(0);
		expect(frames).toEqual([{ t: 'patch', view: 'all', v: 2, ops: [{ op: 'upsert', index: 0, row: { id: 'o1', title: 'desk' } },
			{ op: 'upsert', index: 1, row: { id: 'o2', title: 'desk' } }] }, { t: 'v', v: 2 }]);
	});
});

describe('engine/live: deltas from the RETURNING image (rule 65)', () => {
	const O = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
	const row = (n: number, over: { [k: string]: Json } = {}) => order({ id: O(n), title: `t${n}`, ...over });
	/** One view over `first`, one commit, and what the connection saw: its frames after registering and the reads it caused. */
	async function after(query: { [k: string]: Json }, first: Json, commit: readonly Captured[], who: Authority = admin, got: (r: ReadIR) => Json = () => null) {
		let answered = false;
		const { hub, frames, asked, connect } = setup((r) => answered ? got(r) : (answered = true, first));
		const c = connect(who);
		await hub.register(c, 'v', { read: ir.read(cat, 'orders', query) });
		frames.length = 0;
		asked.length = 0;
		hub.publish(commit);
		await hub.settled();
		return { frames: frames.filter((f) => f.t !== 'v'), asked, sweep: hub.sweep() };
	}
	const titles = { select: { title: true }, all: true };

	it('an insert is placed by the order (here `id`) with no read', async () => {
		const x = await after(titles, page({ id: O(1), title: 't1' }, { id: O(3), title: 't3' }), [cap(null, row(2))]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 't2' } }] }]);
		expect(x.asked).toEqual([]);
	});

	const at = (h: number) => `2026-09-25T0${h}:00:00+00:00`, $t = (h: number) => ({ $t: `2026-09-25T0${h}:00:00.000Z` });
	const newest = { all: true, orderBy: { created_at: 'desc' }, select: { title: true, created_at: true } };

	it('an update that keeps the order keys replaces the row in place', async () => {
		const x = await after(newest, page({ id: O(1), title: 't1', created_at: $t(2) }, { id: O(2), title: 't2', created_at: $t(1) }),
			[cap(row(2, { created_at: at(1) }), row(2, { title: 'new', created_at: at(1) }))]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 'new', created_at: $t(1) } }] }]);
		expect(x.asked).toEqual([]);
	});

	it('an update that moves an order key reorders the row', async () => {
		const x = await after(newest, page({ id: O(1), title: 't1', created_at: $t(2) }, { id: O(2), title: 't2', created_at: $t(1) }),
			[cap(row(2, { created_at: at(1) }), row(2, { created_at: at(3) }))]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: { id: O(2), title: 't2', created_at: $t(3) } }] }]);
		expect(x.asked).toEqual([]);
	});

	it('an update that leaves the filter, and a delete, remove the row', async () => {
		const drafts = { ...titles, where: { status: { eq: 'draft' } } };
		const x = await after(drafts, page({ id: O(1), title: 't1' }, { id: O(2), title: 't2' }), [cap(row(1), row(1, { status: 'submitted' })), cap(row(2), null)]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'remove', id: O(1) }, { op: 'remove', id: O(2) }] }]);
		expect(x.asked).toEqual([]);
	});

	it("a field masked to the caller is `$masked` on another's row and plain on the caller's own", async () => {
		const both = compileAuthority(manifest, { actor: member('u1'), policies: ['rep', 'auditor'], admin: false }, 'both');
		const x = await after({ select: { title: true, note: true }, all: true }, page(),
			[cap(null, row(1, { note: 'mine' })), cap(null, row(2, { note: 'theirs', created_by: 'u2' }))], both);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', note: 'mine' } },
			{ op: 'upsert', index: 1, row: { id: O(2), title: 't2', note: { $masked: true } } }] }]);
		expect(x.asked).toEqual([]);
	});

	it('a select with a relation reads the one row by id and patches it in (counted)', async () => {
		const withCustomer = { select: { title: true, customer: { select: { name: true } } }, all: true };
		const got = { id: O(1), title: 't1', customer: { id: 'c1', name: 'Acme' } };
		const x = await after(withCustomer, page(), [cap(null, row(1))], admin, () => got);
		expect(x.asked).toEqual([{ kind: 'get', collection: 'orders', id: O(1), select: { fields: ['title'], relations: { customer: expect.anything() } } }]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: got }] }]);
		expect(x.sweep.conservative).toBe(1);
	});

	it('a removal from a limited page that has more rows beyond re-reads the view to backfill it (counted)', async () => {
		const x = await after({ select: { title: true }, limit: 2 }, { rows: [{ id: O(1), title: 't1' }, { id: O(2), title: 't2' }], next: 'cursor' },
			[cap(row(1), null)], admin, () => ({ rows: [{ id: O(2), title: 't2' }, { id: O(3), title: 't3' }], next: null }));
		expect(x.asked).toEqual([expect.objectContaining({ kind: 'read', page: { limit: 2 } })]);
		expect(x.frames).toEqual([{ t: 'answer', view: 'v', v: 1, value: { rows: [{ id: O(2), title: 't2' }, { id: O(3), title: 't3' }], next: null } }]);
		expect(x.sweep.conservative).toBe(1);
	});

	it('a decimal the commit image carries as text keeps its scale and patches with no read', async () => {
		const x = await after({ select: { title: true, total: true }, all: true }, page(), [cap(null, row(1, { total: '1.20' }))]);
		expect(x.asked).toEqual([]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', total: { $dec: '1.20' } } }] }]);
		expect(x.sweep.conservative).toBe(0);
	});

	it('a decimal that arrives as a JSON number (an approval image) has lost its scale and reads the one row by id', async () => {
		const x = await after({ select: { title: true, total: true }, all: true }, page(), [cap(null, row(1, { total: 1.2 }))], admin,
			() => ({ id: O(1), title: 't1', total: { $dec: '1.20' } }));
		expect(x.asked.map((r) => r.kind)).toEqual(['get']);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', total: { $dec: '1.20' } } }] }]);
	});
});

describe('engine/live: a view sorted by a related field (rule 65)', () => {
	const O = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
	const row = (n: number, over: { [k: string]: Json } = {}) => order({ id: O(n), title: `t${n}`, customer: 'c1', ...over });
	const byCustomer = { select: { title: true }, all: true, orderBy: { customer: { name: 'asc' } } };
	const two = page({ id: O(1), title: 't1' }, { id: O(2), title: 't2' });
	async function after(commit: readonly Captured[], reread: Json = null) {
		let answered = false;
		const { hub, frames, asked, connect } = setup((r) => answered ? reread : (answered = true, two));
		const c = connect(admin);
		await hub.register(c, 'v', { read: ir.read(cat, 'orders', byCustomer) });
		frames.length = 0;
		asked.length = 0;
		hub.publish(commit);
		await hub.settled();
		return { frames: frames.filter((f) => f.t !== 'v'), asked, sweep: hub.sweep() };
	}

	it('renaming the target row makes the view undecidable: it re-reads (counted)', async () => {
		const swapped = page({ id: O(2), title: 't2' }, { id: O(1), title: 't1' });
		const x = await after([cap({ id: 'c1', name: 'Acme', blocked: false }, { id: 'c1', name: 'Zeta', blocked: false }, 'customers')], swapped);
		expect(x.asked).toEqual([expect.objectContaining({ kind: 'read', collection: 'orders', order: [{ field: 'customer.name', dir: 'asc' }] })]);
		expect(x.frames).toEqual([{ t: 'answer', view: 'v', v: 1, value: swapped }]);
		expect(x.sweep.conservative).toBe(1);
	});

	it('a row whose relation is unchanged is patched in place with no read', async () => {
		const x = await after([cap(row(2), row(2, { title: 'new' }))]);
		expect(x.asked).toEqual([]);
		expect(x.frames).toEqual([{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 'new' } }] }]);
	});

	it('a changed relation or an insert cannot be placed from the image: the view re-reads', async () => {
		const moved = await after([cap(row(2), row(2, { customer: 'c2' }))], two);
		expect(moved.asked).toEqual([expect.objectContaining({ kind: 'read', collection: 'orders' })]);
		const inserted = await after([cap(null, row(3))], two);
		expect(inserted.asked).toEqual([expect.objectContaining({ kind: 'read', collection: 'orders' })]);
		expect(inserted.sweep.conservative).toBe(1);
	});
});

describe('engine/live: registration (rule 64) and budgets (rule 65)', () => {
	it('a clock read needs every; a collection query needs every or on; a cursor page is not liveable', async () => {
		const { hub, connect } = setup();
		const c = connect();
		const clock = ir.read(cat, 'orders', { where: { created_at: { gte: { now: '-1d' } } }, all: true });
		const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code: string }) => e.code);
		expect(await code(hub.register(c, 'a', { read: clock }))).toBe('invalid');
		expect(await code(hub.register(c, 'a', { read: clock, every: '1min' }))).toBe('ok');
		expect(await code(hub.register(c, 'q', { read: { kind: 'query', collection: 'orders', query: 'open', input: null } }))).toBe('invalid');
		expect(await code(hub.register(c, 'q', { read: { kind: 'query', collection: 'orders', query: 'open', input: null }, on: ['orders'] }))).toBe('ok');
		expect(await code(hub.register(c, 'p', { read: { ...ir.read(cat, 'orders', { limit: 5 }), page: { limit: 5, after: 'x' } } as ReadIR }))).toBe('invalid');
		hub.disconnect(c);
	});

	it('an answer over 2 MiB errors that view alone; the stream and its other views go on', async () => {
		const big = 'x'.repeat(LIVE.subscriptionBytes);
		const { hub, frames, connect, ended } = setup((r) => r.kind === 'get' ? big : null);
		const c = connect();
		await hub.register(c, 'big', { read: ir.get(cat, 'orders', 'o1') });
		await hub.register(c, 'all', { read: ir.read(cat, 'orders', { all: true }) });
		expect(frames.filter((f) => f.t === 'error')).toEqual([expect.objectContaining({ view: 'big', code: 'subscriptionTooLarge' })]);
		expect(answers(frames)).toEqual(['all']);
		expect(ended()).toBe(false);
		expect(hub.retained()).toBeLessThan(100);
	});

	it('the 501st view on a connection is tooManySubscriptions', async () => {
		const { hub, connect } = setup();
		const c = connect();
		for (let i = 0; i < LIVE.perConnection; i++) await hub.register(c, `v${i}`, { read: ir.get(cat, 'orders', `o${i}`) });
		await expect(hub.register(c, 'one-more', { read: ir.get(cat, 'orders', 'x') })).rejects.toMatchObject({ code: 'tooManySubscriptions' });
	});

	it('an authority change re-answers; a generation change closes with { release } (rule 66)', async () => {
		const { hub, frames, connect, ended } = setup();
		const c = connect();
		await hub.register(c, 'all', { read: ir.read(cat, 'orders', { all: true }) });
		frames.length = 0;
		await hub.authorize(c, rep);
		expect(answers(frames)).toEqual(['all']);
		hub.close('r2');
		expect(frames.at(-1)).toEqual({ t: 'close', release: 'r2' });
		expect(ended()).toBe(true);
		expect(hub.retained()).toBe(0);
	});
});

describe('protocol/wire (rule 32)', () => {
	it('maps outcomes to HTTP and gives public and API-key actors codes only', () => {
		const refused = { kind: 'refused', code: 'unique', message: 'That name is taken.', field: 'name' } as const;
		expect([statusOf({ kind: 'committed', output: null, records: [] }), statusOf({ kind: 'pendingApproval', requestId: 'r', records: [] }),
			statusOf({ kind: 'conflict', records: [] }), statusOf({ kind: 'unknown', invocation: 'i' }), statusOf(refused),
			statusOf({ ...refused, code: 'forbidden' }), statusOf({ ...refused, code: 'rateLimited' })]).toEqual([200, 202, 409, 504, 422, 403, 429]);
		expect(redact(refused, { kind: 'apiKey', key: 'k' })).toEqual({ kind: 'refused', code: 'unique', message: 'unique', field: 'name' });
		expect(redact(refused, member('u1'))).toBe(refused);
	});
});

describe('$bolt client without a server', () => {
	it('a refused write paints while in flight and un-paints; a network failure is unknown with the key (rules 32, 67)', async () => {
		let es: EventSourceLike | undefined;
		const push = (f: Frame) => es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(f) }));
		let during = -1, offline = false;
		const fetch = async (url: string | URL | Request) => {
			if (String(url).endsWith('/live')) return Response.json({ errors: [] });
			if (offline) throw new TypeError('offline');
			during = rows().length;
			return Response.json({ outcome: { kind: 'refused', code: 'forbidden', message: 'No.' }, v: 0 }, { status: 403 });
		};
		const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, uuid: () => 'k1',
			openStream: () => (es = { onmessage: null, onerror: null, close() {} }) });
		const view = bolt.live(bolt.read('orders', { all: true }));
		const rows = () => (view.current as { rows: Json[] }).rows;
		const stop = view.subscribe(() => {});
		push({ t: 'hello', conn: 'c1', v: 0 });
		push({ t: 'answer', view: 'v1', v: 0, value: { rows: [order()], next: null } });
		expect(await bolt.act('orders.create', { title: 'x' })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect([during, rows().length]).toEqual([2, 1]);
		offline = true;
		expect(await bolt.act('orders.create', { title: 'x' })).toEqual({ kind: 'unknown', invocation: 'k1' });
		expect(rows()).toHaveLength(1);
		expect(bolt.t('hello {name}', { name: 'Ada' })).toBe('hello Ada');
		stop();
	});

	it('applies patches in lane order, ignores a stale one and re-registers a view a patch does not fit (rule 65)', async () => {
		let es: EventSourceLike | undefined;
		const push = (f: Frame) => es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(f) }));
		const registered: LiveBody[] = [];
		const fetch = async (_: string | URL | Request, init?: RequestInit) => { registered.push(JSON.parse(String(init!.body)) as LiveBody); return Response.json({ errors: [] }); };
		const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, openStream: () => (es = { onmessage: null, onerror: null, close() {} }) });
		const view = bolt.live(bolt.read('orders', { all: true }));
		const titles = () => (view.current as unknown as { rows: { title: string }[] }).rows.map((r) => r.title);
		const stop = view.subscribe(() => {});
		push({ t: 'hello', conn: 'c1', v: 0 });
		push({ t: 'answer', view: 'v1', v: 1, value: { rows: [order()], next: null } });
		push({ t: 'patch', view: 'v1', v: 2, ops: [{ op: 'upsert', index: 0, row: order({ id: 'o0', title: 'chair' }) }, { op: 'upsert', index: 1, row: order({ title: 'lamp' }) }] });
		expect(titles()).toEqual(['chair', 'lamp']);
		push({ t: 'patch', view: 'v1', v: 2, ops: [{ op: 'remove', id: 'o0' }] });
		expect(titles()).toEqual(['chair', 'lamp']);
		await new Promise((r) => setTimeout(r, 0));
		registered.length = 0;
		push({ t: 'patch', view: 'v1', v: 3, ops: [{ op: 'upsert', index: 5, row: order({ id: 'o9' }) }] });
		expect(titles()).toEqual(['chair', 'lamp']);
		expect(registered).toEqual([{ conn: 'c1', drop: [], add: [{ view: 'v1', read: { m: 'read', a: ['orders', { all: true }] } }] }]);
		stop();
	});

	it('a dropped link reports down, retries on a doubling backoff, and the next hello re-answers every view; `close` retires it',
		async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5); // the jitter, mid: exact waits
		try {
			const sources: EventSourceLike[] = [];
			const closed: string[] = [];
			const registered: LiveBody[] = [];
			const fetch = async (_: string | URL | Request, init?: RequestInit) => { registered.push(JSON.parse(String(init!.body)) as LiveBody); return Response.json({ errors: [] }); };
			const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, openStream: () => {
				const s: EventSourceLike = { onmessage: null, onerror: null, close: () => closed.push(`s${sources.length - 1}`) };
				sources.push(s);
				return s;
			} });
			const statuses: SyncStatus[] = [];
			bolt.onSyncStatus((s) => statuses.push(s));
			const push = (f: Frame) => sources[sources.length - 1]!.onmessage!(new MessageEvent('message', { data: JSON.stringify(f) }));
			const drop = () => sources[sources.length - 1]!.onerror!(new Event('error'));
			const view = bolt.live(bolt.read('orders', { all: true }));
			const stop = view.subscribe(() => {});
			expect(statuses).toEqual(['idle']); // the shell's opening state, until the first `hello`
			push({ t: 'hello', conn: 'c1', v: 0 });
			push({ t: 'answer', view: 'v1', v: 0, value: { rows: [order()], next: null } });
			expect(bolt.syncStatus).toBe('live');
			expect(statuses.at(-1)).toBe('live');
			// a drop reads as down, not idle, and is retried off a doubling backoff rather than left dead
			drop();
			expect(closed).toEqual(['s0']);
			expect(bolt.syncStatus).toBe('connecting');
			await vi.advanceTimersByTimeAsync(499);
			expect(sources).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(sources).toHaveLength(2);
			drop();
			await vi.advanceTimersByTimeAsync(999);
			expect(sources).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(sources).toHaveLength(3);
			// the one connection carries every view again, and answers it without the page re-subscribing
			push({ t: 'hello', conn: 'c2', v: 4 });
			push({ t: 'answer', view: 'v1', v: 4, value: { rows: [order({ id: 'o2' })], next: null } });
			expect(registered.map((b) => b.conn)).toEqual(['c1', 'c2']);
			expect(registered[1]!.add!.map((a) => a.view)).toEqual(['v1']);
			expect((view.current as unknown as { rows: { id: string }[] }).rows[0]!.id).toBe('o2');
			expect(statuses.at(-1)).toBe('live');
			// a retired client closes its stream and stops reporting
			statuses.length = 0;
			bolt.close();
			expect(closed).toEqual(['s0', 's1', 's2']); // each drop closed its own source; `close` the last one
			expect(bolt.syncStatus).toBe('idle');
			expect(statuses).toEqual([]);
			stop();
		} finally { random.mockRestore(); vi.useRealTimers(); }
	});

	it('a drop backs off from 0.5 s ±50% and wakes on `online`; background tabs keep retrying',
		async () => {
		vi.useFakeTimers();
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5); // the jitter, mid: exact waits
		try {
			const sources: EventSourceLike[] = [];
			const closed: string[] = [];
			const registered: LiveBody[] = [];
			const fetch = async (_: string | URL | Request, init?: RequestInit) => { registered.push(JSON.parse(String(init!.body)) as LiveBody); return Response.json({ errors: [] }); };
			const listeners: { [type: string]: () => void } = {};
			const signals = { hidden: false, addEventListener: (type: string, run: () => void) => { listeners[type] = run; } };
			const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, signals, openStream: () => {
				const s: EventSourceLike = { onmessage: null, onerror: null, close: () => closed.push(`s${sources.length - 1}`) };
				sources.push(s);
				return s;
			} });
			const push = (f: Frame) => sources[sources.length - 1]!.onmessage!(new MessageEvent('message', { data: JSON.stringify(f) }));
			/** Drops the link and returns how many sources existed while it was down. */
			const drop = () => { const down = sources.length; sources[down - 1]!.onerror!(new Event('error')); expect(bolt.syncStatus).toBe('connecting'); return down; };
			/** Advances the clock and asserts the link came back, or did not. */
			const after = async (ms: number, want: number) => { await vi.advanceTimersByTimeAsync(ms); expect(sources).toHaveLength(want); };
			const view = bolt.live(bolt.read('orders', { all: true }));
			const stop = view.subscribe(() => {});
			let conns = 0;
			const hello = () => push({ t: 'hello', conn: `c${++conns}`, v: conns });
			hello();

			// the wait is 0.5 s doubled per consecutive drop and spread ±50%: 250 ms at the low end of the first,
			// 1.5 s at the high end of the second, and a frame at all resets it
			random.mockReturnValue(0);
			const low = drop();
			await after(249, low);
			await after(1, low + 1);
			random.mockReturnValue(0.999);
			const high = drop();
			await after(1_498, high);
			await after(1, high + 1);
			random.mockReturnValue(0.5);
			// a source that opens and then dies before its first frame is what grows the wait, to the 30 s cap
			for (const wait of [2_000, 4_000, 8_000, 16_000, 30_000]) {
				const down = drop();
				await after(wait - 1, down);
				await after(1, down + 1);
			}
			// `online` says the network is back, so a wait that was only the network's is over and the link returns at once
			const slept = drop();
			listeners['online']!();
			expect(sources).toHaveLength(slept + 1);
			// A hidden tab keeps retrying even at the maximum backoff.
			const capped = drop();
			signals.hidden = true;
			listeners['visibilitychange']!();
			await after(30_000, capped + 1);
			expect(closed).toHaveLength(capped);
			expect(bolt.syncStatus).toBe('connecting');
			// shown: the one connection is back and re-answers every view, with nothing re-subscribed
			signals.hidden = false;
			listeners['visibilitychange']!();
			expect(sources).toHaveLength(capped + 1);
			hello();
			expect(registered.map((b) => b.conn)).toEqual(Array.from({ length: conns }, (_, i) => `c${i + 1}`));
			expect(registered.at(-1)!.add!.map((a) => a.view)).toEqual(['v1']);
			expect(bolt.syncStatus).toBe('live');
			stop();
		} finally { random.mockRestore(); vi.useRealTimers(); }
	});

	it('a closed client holds nothing: its signal listeners come off and no view grace timer stays armed', async () => {
		vi.useFakeTimers();
		try {
			const listening = new Set<string>();
			const signals = {
				hidden: false,
				addEventListener: (type: string) => { listening.add(type); },
				removeEventListener: (type: string) => { listening.delete(type); },
			};
			let closed = 0;
			const fetch = async () => Response.json({ errors: [] });
			const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, signals,
				openStream: () => ({ onmessage: null, onerror: null, close: () => { closed++; } }) });
			const stop = bolt.live(bolt.read('orders', { all: true })).subscribe(() => {});
			expect([...listening].sort()).toEqual(['online', 'visibilitychange']);
			bolt.close();
			stop(); // an unmount after the shell retired its client
			expect(listening.size).toBe(0);
			expect(closed).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it('all queries share one connection that remains live in a hidden tab', async () => {
		vi.useFakeTimers();
		try {
			const sources: EventSourceLike[] = [];
			const signals = { hidden: true, addEventListener: () => {} };
			const fetch = async () => Response.json({ errors: [] });
			const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, signals, openStream: () => {
				const s: EventSourceLike = { onmessage: null, onerror: null, close: () => {} };
				sources.push(s);
				return s;
			} });
			const stop = bolt.live(bolt.read('orders', { all: true })).subscribe(() => {});
			expect(sources).toHaveLength(1); // was 0: a never-shown tab counted as hidden since the epoch, so its reads never answered
			await vi.advanceTimersByTimeAsync(300_000);
			expect(sources).toHaveLength(1);
			// More queries in a hidden tab use the existing connection.
			const next = bolt.live(bolt.read('orders', { where: { region: 'north' } })).subscribe(() => {});
			expect(sources).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(300_000);
			expect(sources).toHaveLength(1);
			stop();
			next();
		} finally { vi.useRealTimers(); }
	});

	it('a missing server connection reconnects, and a late old registration cannot poison recovered views', async () => {
		const sources: EventSourceLike[] = [];
		const pending: ((r: Response) => void)[] = [];
		const bolt = createBolt({ actor: null, locale: 'en',
			fetch: (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch,
			openStream: () => { const source: EventSourceLike = { onmessage: null, onerror: null, close() {} }; sources.push(source); return source; } });
		const push = (frame: Frame) => sources.at(-1)!.onmessage!(new MessageEvent('message', { data: JSON.stringify(frame) }));
		const view = bolt.live(bolt.read('orders', { all: true }));
		view.subscribe(() => {});
		push({ t: 'hello', conn: 'c1', v: 0 });
		const another = bolt.live(bolt.read('orders', { where: { region: 'north' } }));
		another.subscribe(() => {});
		const gone = () => Response.json({ errors: [{ view: 'v1', code: 'notFound', message: 'the live connection is gone' }] });
		pending[0]!(gone());
		await vi.waitFor(() => expect(sources).toHaveLength(2));
		expect(view.error).toBeUndefined();
		push({ t: 'hello', conn: 'c1', v: 1 }); // a restarted server may reuse its connection ids
		push({ t: 'answer', view: 'v1', v: 1, value: { rows: [order()], next: null } });
		pending[1]!(gone());
		pending[2]!(Response.json({ errors: [] }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(view.error).toBeUndefined();
		expect(sources).toHaveLength(2);
		expect(bolt.syncStatus).toBe('live');
		bolt.close();
	});

	it('one committed change reaches subscriptions on both tab connections', async () => {
		const { hub } = setup(() => ({ rows: [order()], next: null }));
		const tabs: Frame[][] = [[], []];
		for (const frames of tabs) {
			const conn = hub.connect(admin, (frame) => frames.push(frame), () => {});
			await hub.register(conn, 'v1', { read: ir.read(cat, 'orders', { all: true }) });
			frames.length = 0;
		}
		hub.publish([cap(order(), order({ title: 'updated in another tab' }))]);
		await hub.settled();
		for (const frames of tabs) expect(frames).toContainEqual(expect.objectContaining({ t: 'patch', view: 'v1' }));
	});

});