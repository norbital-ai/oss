// engine/live, protocol/wire and the $bolt client without a database: one guarantee per test (rules 32, 64–67).
import { describe, expect, it } from '@effect/vitest';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Queue,
	Random,
	Schema,
	Scope,
	Stream
} from 'effect';
import { TestClock } from 'effect/testing';
import { Live, Manifest, Reads, type ReadsShape } from '../src/engine/services.ts';
import type { ReadIR } from '../src/protocol/ir-types.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { Json } from '../src/decl/values.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import type { Authority, Captured, EngineActor } from '../src/engine/contracts.ts';
import { LIVE, LiveHubLive } from '../src/engine/live/hub.ts';
import * as ir from '../src/protocol/ir.ts';
import { createBolt, type BoltConfig, type SyncStatus } from '../src/page/bolt.ts';
import { liveStream, type EventSourceLike } from '../src/page/stream.ts';
import { redact, statusOf, type Frame } from '../src/protocol/wire.ts';
import { ActBody, LiveBody } from '../src/protocol/schema.ts';
import { manifest } from './engine-fixture.ts';

const cat = catalogOf(manifest);
const NOW = '2026-09-25T10:00:00.000Z';
const bindings = () => ({ now: NOW, today: '2026-09-25', tz: 'UTC', params: {} });
const member = (id: string): EngineActor => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [],
	teamPath: [],
	admin: false,
	party: null
});
const admin = compileAuthority(
	manifest,
	{ actor: member('root'), policies: [], admin: true },
	'admin'
);
const rep = compileAuthority(
	manifest,
	{ actor: member('u1'), policies: ['rep'], admin: false },
	'rep'
);
const order = (over: { [k: string]: Json } = {}) => ({
	id: 'o1',
	title: 'desk',
	region: 'north',
	status: 'draft',
	created_by: 'u1',
	revision: 1,
	...over
});
const cap = (
	old: { [k: string]: Json } | null,
	next: { [k: string]: Json } | null,
	collection = 'orders'
): Captured => {
	const row = next ?? old;
	if (row === null) throw new Error('A capture needs its pre- or post-image');
	return {
		collection,
		id: String(row['id']),
		op: old === null ? 'create' : next === null ? 'delete' : 'update',
		revision: 1,
		old,
		new: next,
		cause: 'direct'
	};
};

const makeHub = (run: ReadsShape['run']) =>
	Effect.map(
		Layer.build(
			LiveHubLive.pipe(
				Layer.provide(
					Layer.mergeAll(Layer.succeed(Manifest, manifest), Layer.succeed(Reads, { run }))
				)
			)
		),
		(context) => Context.get(context, Live)
	);
const connection = Effect.fn('Test.liveConnection')(function* (
	hub: ReturnType<typeof Live.of>,
	authority: Authority,
	frames: Frame[],
	end: () => void = () => {}
) {
	const ready = yield* Deferred.make<string>();
	const fiber = yield* hub.connect(authority).pipe(
		Stream.runForEach((frame) =>
			Effect.sync(() => {
				frames.push(frame);
				if (frame.t === 'hello') Deferred.doneUnsafe(ready, Effect.succeed(frame.conn));
			})
		),
		Effect.ensuring(Effect.sync(end)),
		Effect.forkScoped
	);
	return { id: yield* Deferred.await(ready), fiber };
});
/** All hubs and their connection streams are scope-owned; routing settles before the independent frame consumer. */
const setup = Effect.fn('Test.liveSetup')(function* (answer: (read: ReadIR) => Json = () => null) {
	const asked: ReadIR[] = [];
	let n = 0;
	const hub = yield* makeHub((batch) =>
		Effect.sync(() => batch.map((read) => (asked.push(read), answer(read) ?? ++n)))
	);
	const frames: Frame[] = [];
	let ended = false;
	const connections = new Map<string, Fiber.Fiber<void, never>>();
	const connect = Effect.fn('Test.liveConnect')(function* (authority: Authority = admin) {
		const opened = yield* connection(hub, authority, frames, () => {
			ended = true;
		});
		connections.set(opened.id, opened.fiber);
		return opened.id;
	});
	const disconnect = (id: string) => {
		const fiber = connections.get(id);
		return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
	};
	return { hub, frames, asked, connect, disconnect, ended: () => ended };
});
const answers = (frames: readonly Frame[]) =>
	frames.flatMap((f) => (f.t === 'answer' ? [f.view] : []));
const patches = (frames: readonly Frame[]) =>
	frames.flatMap((f) => (f.t === 'patch' ? [[f.view, f.ops] as const] : []));
const page = (...rows: Json[]) => ({ rows, next: null });

describe('engine/live: routing on pre- and post-images (rule 65)', () => {
	it.effect(
		'coalesces outbound metadata refreshes for visible records and retains caller authority',
		() =>
			Effect.gen(function* () {
				let status = 'pending';
				const asked: { reads: readonly ReadIR[]; authority: Authority }[] = [];
				const hub = yield* makeHub((reads, reader) =>
					Effect.sync(() => {
						const authority = reader.as === 'caller' ? reader.authority : rep;
						asked.push({ reads, authority });
						return reads.map((read) =>
							read.kind === 'get'
								? { id: 'o1', $outbound: { 'mail.orders': { status, error: null } } }
								: page({ id: 'o1', $outbound: { 'mail.orders': { status, error: null } } })
						);
					})
				);
				const frames: Frame[] = [];
				const conn = (yield* connection(hub, rep, frames)).id;
				yield* hub.register(conn, 'record', { read: ir.get(cat, 'orders', 'o1') });
				yield* hub.register(conn, 'other', { read: ir.get(cat, 'orders', 'o2') });
				yield* hub.register(conn, 'table', { read: ir.read(cat, 'orders', { all: true }) });
				yield* hub.register(conn, 'customers', { read: ir.read(cat, 'customers', { all: true }) });
				asked.length = 0;
				yield* TestClock.adjust(0);
				frames.length = 0;
				status = 'failed';
				hub.syncChanged('orders', ['o1']);
				hub.syncChanged('orders', ['o1']);
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(asked).toEqual([
					{
						reads: [ir.get(cat, 'orders', 'o1'), ir.read(cat, 'orders', { all: true })],
						authority: rep
					}
				]);
				expect(answers(frames)).toEqual(['record', 'table']);
				expect(frames.filter((frame) => frame.t === 'answer')).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							view: 'record',
							v: 2,
							value: { id: 'o1', $outbound: { 'mail.orders': { status: 'failed', error: null } } }
						})
					])
				);
				asked.length = 0;
				yield* TestClock.adjust(0);
				frames.length = 0;
				status = 'success';
				hub.syncChanged('orders');
				hub.syncChanged('orders', ['o1']);
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(asked).toEqual([
					{
						reads: [
							ir.get(cat, 'orders', 'o1'),
							ir.get(cat, 'orders', 'o2'),
							ir.read(cat, 'orders', { all: true })
						],
						authority: rep
					}
				]);
				expect(answers(frames)).toEqual(['record', 'other', 'table']);
			})
	);
	it.effect(
		'inbox arrivals exclude commits queued before registration and another member, while fresh commits carry arrival data',
		() =>
			Effect.gen(function* () {
				const { hub, frames, connect } = yield* setup(() => ({ rows: [], unread: 0 }));
				const conn = yield* connect(rep);
				const notice = (id: string, member = 'u1') =>
					cap(null, { id, member, title: id, at: NOW, read_at: null }, 'sys_notification');
				hub.publish([notice('queued-before-boot')]);
				yield* hub.register(conn, 'inbox', {
					read: { kind: 'inbox', collection: 'sys_notification', member: 'u1' }
				});
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(frames.filter((f) => f.t === 'answer').every((f) => !('arrivals' in f))).toBe(true);
				yield* TestClock.adjust(0);
				frames.length = 0;
				hub.publish([notice('new-arrival'), notice('private', 'u2')]);
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(frames.find((f) => f.t === 'answer')).toMatchObject({
					view: 'inbox',
					arrivals: [{ id: 'new-arrival', title: 'new-arrival' }]
				});
			})
	);
	it.effect(
		're-answers only the views a commit touches; an undecidable view is re-answered and counted',
		() =>
			Effect.gen(function* () {
				const { hub, frames, asked, connect } = yield* setup((r) =>
					r.kind === 'read' ? page() : null
				);
				const c = yield* connect();
				const title = { title: true };
				yield* hub.register(c, 'submitted', {
					read: ir.read(cat, 'orders', {
						where: { status: { eq: 'submitted' } },
						select: title,
						all: true
					})
				});
				yield* hub.register(c, 'all', {
					read: ir.read(cat, 'orders', { select: title, all: true })
				});
				yield* hub.register(c, 'other', { read: ir.get(cat, 'orders', 'o2') });
				yield* hub.register(c, 'byCustomer', {
					read: ir.read(cat, 'orders', {
						where: { customer: { is: { blocked: { eq: false } } } },
						select: title,
						all: true
					})
				});
				yield* hub.register(c, 'customers', { read: ir.read(cat, 'customers', { all: true }) });
				yield* TestClock.adjust(0);
				frames.length = 0;
				asked.length = 0;
				hub.publish([cap(null, order())]);
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(patches(frames)).toEqual([
					['all', [{ op: 'upsert', index: 0, row: { id: 'o1', title: 'desk' } }]]
				]);
				expect(asked).toEqual([
					expect.objectContaining({ where: expect.objectContaining({ t: 'one' }) })
				]); // re-read; its answer did not change
				expect(yield* hub.sweep).toEqual({ conservative: 1, views: [`${c}/byCustomer`] });
			})
	);

	it.effect('a row leaving a view (pre-image in, post-image out) is removed from it', () =>
		Effect.gen(function* () {
			const { hub, frames, asked, connect } = yield* setup(() => page({ id: 'o1', title: 'desk' }));
			const c = yield* connect();
			yield* hub.register(c, 'drafts', {
				read: ir.read(cat, 'orders', {
					where: { status: { eq: 'draft' } },
					select: { title: true },
					all: true
				})
			});
			yield* TestClock.adjust(0);
			frames.length = 0;
			asked.length = 0;
			hub.publish([cap(order(), order({ status: 'submitted' }))]);
			yield* hub.settled;
			yield* TestClock.adjust(0);
			expect(patches(frames)).toEqual([['drafts', [{ op: 'remove', id: 'o1' }]]]);
			expect(asked).toEqual([]);
		})
	);

	it.effect("a row outside the caller's read scope before and after is not routed to it", () =>
		Effect.gen(function* () {
			const { hub, frames, connect } = yield* setup(() => page());
			const c = yield* connect(rep);
			yield* hub.register(c, 'mine', {
				read: ir.read(cat, 'orders', { select: { title: true }, all: true })
			});
			yield* TestClock.adjust(0);
			frames.length = 0;
			hub.publish([cap(null, order({ created_by: 'someone-else' }))]);
			yield* hub.settled;
			yield* TestClock.adjust(0);
			expect(patches(frames)).toEqual([]);
			hub.publish([cap(null, order({ id: 'o3' }))]);
			yield* hub.settled;
			yield* TestClock.adjust(0);
			expect(patches(frames).map(([view]) => view)).toEqual(['mine']);
		})
	);

	it.effect(
		'commits coalesce per lane batch: one patch per view, no read, stamped with the batch sequence, then `v`',
		() =>
			Effect.gen(function* () {
				const { hub, frames, asked, connect } = yield* setup(() => page());
				const c = yield* connect();
				yield* hub.register(c, 'all', {
					read: ir.read(cat, 'orders', { select: { title: true }, all: true })
				});
				asked.length = 0;
				yield* TestClock.adjust(0);
				frames.length = 0;
				expect([
					hub.publish([cap(null, order())]),
					hub.publish([cap(null, order({ id: 'o2' }))])
				]).toEqual([1, 2]);
				yield* hub.settled;
				yield* TestClock.adjust(0);
				expect(asked).toHaveLength(0);
				expect(frames).toEqual([
					{
						t: 'patch',
						view: 'all',
						v: 2,
						ops: [
							{ op: 'upsert', index: 0, row: { id: 'o1', title: 'desk' } },
							{ op: 'upsert', index: 1, row: { id: 'o2', title: 'desk' } }
						]
					},
					{ t: 'v', v: 2 }
				]);
			})
	);
});

describe('engine/live: deltas from the RETURNING image (rule 65)', () => {
	const O = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
	const row = (n: number, over: { [k: string]: Json } = {}) =>
		order({ id: O(n), title: `t${n}`, ...over });
	/** One view over `first`, one commit, and what the connection saw: its frames after registering and the reads it caused. */
	const after = Effect.fn('Test.after')(function* (
		query: { [k: string]: Json },
		first: Json,
		commit: readonly Captured[],
		who: Authority = admin,
		got: (r: ReadIR) => Json = () => null
	) {
		let answered = false;
		const { hub, frames, asked, connect } = yield* setup((r) =>
			answered ? got(r) : ((answered = true), first)
		);
		const c = yield* connect(who);
		yield* hub.register(c, 'v', { read: ir.read(cat, 'orders', query) });
		yield* TestClock.adjust(0);
		frames.length = 0;
		asked.length = 0;
		hub.publish(commit);
		yield* hub.settled;
		yield* TestClock.adjust(0);
		return { frames: frames.filter((f) => f.t !== 'v'), asked, sweep: yield* hub.sweep };
	});
	const titles = { select: { title: true }, all: true };

	it.effect('an insert is placed by the order (here `id`) with no read', () =>
		Effect.gen(function* () {
			const x = yield* after(titles, page({ id: O(1), title: 't1' }, { id: O(3), title: 't3' }), [
				cap(null, row(2))
			]);
			expect(x.frames).toEqual([
				{
					t: 'patch',
					view: 'v',
					v: 1,
					ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 't2' } }]
				}
			]);
			expect(x.asked).toEqual([]);
		})
	);

	const at = (h: number) => `2026-09-25T0${h}:00:00+00:00`,
		$t = (h: number) => `2026-09-25T0${h}:00:00.000Z`;
	const newest = {
		all: true,
		orderBy: { created_at: 'desc' },
		select: { title: true, created_at: true }
	};

	it.effect('an update that keeps the order keys replaces the row in place', () =>
		Effect.gen(function* () {
			const x = yield* after(
				newest,
				page(
					{ id: O(1), title: 't1', created_at: $t(2) },
					{ id: O(2), title: 't2', created_at: $t(1) }
				),
				[cap(row(2, { created_at: at(1) }), row(2, { title: 'new', created_at: at(1) }))]
			);
			expect(x.frames).toEqual([
				{
					t: 'patch',
					view: 'v',
					v: 1,
					ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 'new', created_at: $t(1) } }]
				}
			]);
			expect(x.asked).toEqual([]);
		})
	);

	it.effect('an update that moves an order key reorders the row', () =>
		Effect.gen(function* () {
			const x = yield* after(
				newest,
				page(
					{ id: O(1), title: 't1', created_at: $t(2) },
					{ id: O(2), title: 't2', created_at: $t(1) }
				),
				[cap(row(2, { created_at: at(1) }), row(2, { created_at: at(3) }))]
			);
			expect(x.frames).toEqual([
				{
					t: 'patch',
					view: 'v',
					v: 1,
					ops: [{ op: 'upsert', index: 0, row: { id: O(2), title: 't2', created_at: $t(3) } }]
				}
			]);
			expect(x.asked).toEqual([]);
		})
	);

	it.effect('an update that leaves the filter, and a delete, remove the row', () =>
		Effect.gen(function* () {
			const drafts = { ...titles, where: { status: { eq: 'draft' } } };
			const x = yield* after(drafts, page({ id: O(1), title: 't1' }, { id: O(2), title: 't2' }), [
				cap(row(1), row(1, { status: 'submitted' })),
				cap(row(2), null)
			]);
			expect(x.frames).toEqual([
				{
					t: 'patch',
					view: 'v',
					v: 1,
					ops: [
						{ op: 'remove', id: O(1) },
						{ op: 'remove', id: O(2) }
					]
				}
			]);
			expect(x.asked).toEqual([]);
		})
	);

	it.effect(
		"a field masked to the caller is `$masked` on another's row and plain on the caller's own",
		() =>
			Effect.gen(function* () {
				const both = compileAuthority(
					manifest,
					{ actor: member('u1'), policies: ['rep', 'auditor'], admin: false },
					'both'
				);
				const x = yield* after(
					{ select: { title: true, note: true }, all: true },
					page(),
					[
						cap(null, row(1, { note: 'mine' })),
						cap(null, row(2, { note: 'theirs', created_by: 'u2' }))
					],
					both
				);
				expect(x.frames).toEqual([
					{
						t: 'patch',
						view: 'v',
						v: 1,
						ops: [
							{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', note: 'mine' } },
							{ op: 'upsert', index: 1, row: { id: O(2), title: 't2', note: { $masked: true } } }
						]
					}
				]);
				expect(x.asked).toEqual([]);
			})
	);

	it.effect('a select with a relation reads the one row by id and patches it in (counted)', () =>
		Effect.gen(function* () {
			const withCustomer = {
				select: { title: true, customer: { select: { name: true } } },
				all: true
			};
			const got = { id: O(1), title: 't1', customer: { id: 'c1', name: 'Acme' } };
			const x = yield* after(withCustomer, page(), [cap(null, row(1))], admin, () => got);
			expect(x.asked).toEqual([
				{
					kind: 'get',
					collection: 'orders',
					id: O(1),
					select: { fields: ['title'], relations: { customer: expect.anything() } }
				}
			]);
			expect(x.frames).toEqual([
				{ t: 'patch', view: 'v', v: 1, ops: [{ op: 'upsert', index: 0, row: got }] }
			]);
			expect(x.sweep.conservative).toBe(1);
		})
	);

	it.effect(
		'a removal from a limited page that has more rows beyond re-reads the view to backfill it (counted)',
		() =>
			Effect.gen(function* () {
				const x = yield* after(
					{ select: { title: true }, limit: 2 },
					{
						rows: [
							{ id: O(1), title: 't1' },
							{ id: O(2), title: 't2' }
						],
						next: 'cursor'
					},
					[cap(row(1), null)],
					admin,
					() => ({
						rows: [
							{ id: O(2), title: 't2' },
							{ id: O(3), title: 't3' }
						],
						next: null
					})
				);
				expect(x.asked).toEqual([
					expect.objectContaining({ kind: 'read', page: { _tag: 'Limit', limit: 2 } })
				]);
				expect(x.frames).toEqual([
					{
						t: 'answer',
						view: 'v',
						v: 1,
						value: {
							rows: [
								{ id: O(2), title: 't2' },
								{ id: O(3), title: 't3' }
							],
							next: null
						}
					}
				]);
				expect(x.sweep.conservative).toBe(1);
			})
	);

	it.effect(
		'a decimal the commit image carries as text keeps its scale and patches with no read',
		() =>
			Effect.gen(function* () {
				const x = yield* after({ select: { title: true, total: true }, all: true }, page(), [
					cap(null, row(1, { total: '1.20' }))
				]);
				expect(x.asked).toEqual([]);
				expect(x.frames).toEqual([
					{
						t: 'patch',
						view: 'v',
						v: 1,
						ops: [
							{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', total: { $dec: '1.20' } } }
						]
					}
				]);
				expect(x.sweep.conservative).toBe(0);
			})
	);

	it.effect(
		'a decimal that arrives as a JSON number (an approval image) has lost its scale and reads the one row by id',
		() =>
			Effect.gen(function* () {
				const x = yield* after(
					{ select: { title: true, total: true }, all: true },
					page(),
					[cap(null, row(1, { total: 1.2 }))],
					admin,
					() => ({ id: O(1), title: 't1', total: { $dec: '1.20' } })
				);
				expect(x.asked.map((r) => r.kind)).toEqual(['get']);
				expect(x.frames).toEqual([
					{
						t: 'patch',
						view: 'v',
						v: 1,
						ops: [
							{ op: 'upsert', index: 0, row: { id: O(1), title: 't1', total: { $dec: '1.20' } } }
						]
					}
				]);
			})
	);
});

describe('engine/live: a view sorted by a related field (rule 65)', () => {
	const O = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
	const row = (n: number, over: { [k: string]: Json } = {}) =>
		order({ id: O(n), title: `t${n}`, customer: 'c1', ...over });
	const byCustomer = { select: { title: true }, all: true, orderBy: { customer: { name: 'asc' } } };
	const two = page({ id: O(1), title: 't1' }, { id: O(2), title: 't2' });
	const after = Effect.fn('Test.after')(function* (
		commit: readonly Captured[],
		reread: Json = null
	) {
		let answered = false;
		const { hub, frames, asked, connect } = yield* setup((r) =>
			answered ? reread : ((answered = true), two)
		);
		const c = yield* connect(admin);
		yield* hub.register(c, 'v', { read: ir.read(cat, 'orders', byCustomer) });
		yield* TestClock.adjust(0);
		frames.length = 0;
		asked.length = 0;
		hub.publish(commit);
		yield* hub.settled;
		yield* TestClock.adjust(0);
		return { frames: frames.filter((f) => f.t !== 'v'), asked, sweep: yield* hub.sweep };
	});

	it.effect('renaming the target row makes the view undecidable: it re-reads (counted)', () =>
		Effect.gen(function* () {
			const swapped = page({ id: O(2), title: 't2' }, { id: O(1), title: 't1' });
			const x = yield* after(
				[
					cap(
						{ id: 'c1', name: 'Acme', blocked: false },
						{ id: 'c1', name: 'Zeta', blocked: false },
						'customers'
					)
				],
				swapped
			);
			expect(x.asked).toEqual([
				expect.objectContaining({
					kind: 'read',
					collection: 'orders',
					order: [{ field: 'customer.name', dir: 'asc' }]
				})
			]);
			expect(x.frames).toEqual([{ t: 'answer', view: 'v', v: 1, value: swapped }]);
			expect(x.sweep.conservative).toBe(1);
		})
	);

	it.effect('a row whose relation is unchanged is patched in place with no read', () =>
		Effect.gen(function* () {
			const x = yield* after([cap(row(2), row(2, { title: 'new' }))]);
			expect(x.asked).toEqual([]);
			expect(x.frames).toEqual([
				{
					t: 'patch',
					view: 'v',
					v: 1,
					ops: [{ op: 'upsert', index: 1, row: { id: O(2), title: 'new' } }]
				}
			]);
		})
	);

	it.effect(
		'a changed relation or an insert cannot be placed from the image: the view re-reads',
		() =>
			Effect.gen(function* () {
				const moved = yield* after([cap(row(2), row(2, { customer: 'c2' }))], two);
				expect(moved.asked).toEqual([
					expect.objectContaining({ kind: 'read', collection: 'orders' })
				]);
				const inserted = yield* after([cap(null, row(3))], two);
				expect(inserted.asked).toEqual([
					expect.objectContaining({ kind: 'read', collection: 'orders' })
				]);
				expect(inserted.sweep.conservative).toBe(1);
			})
	);
});

describe('engine/live: registration (rule 64) and budgets (rule 65)', () => {
	it.effect(
		'a clock read needs every; a collection query needs every or on; a cursor page is not liveable',
		() =>
			Effect.gen(function* () {
				const { hub, connect, disconnect } = yield* setup();
				const c = yield* connect();
				const clock = ir.read(cat, 'orders', {
					where: { created_at: { gte: { now: '-1d' } } },
					all: true
				});
				const code = (
					effect: Effect.Effect<unknown, import('../src/engine/errors.ts').EngineError>
				) =>
					effect.pipe(
						Effect.match({
							onSuccess: () => 'ok',
							onFailure: (error) => (error instanceof BoltError ? error.code : error._tag)
						})
					);
				expect(yield* code(hub.register(c, 'a', { read: clock }))).toBe('invalid');
				expect(yield* code(hub.register(c, 'a', { read: clock, every: '1min' }))).toBe('ok');
				expect(
					yield* code(
						hub.register(c, 'q', {
							read: { kind: 'query', collection: 'orders', query: 'open', input: null }
						})
					)
				).toBe('invalid');
				expect(
					yield* code(
						hub.register(c, 'q', {
							read: { kind: 'query', collection: 'orders', query: 'open', input: null },
							on: ['orders']
						})
					)
				).toBe('ok');
				const cursor = ir.read(cat, 'orders', { limit: 5 });
				if (cursor.kind !== 'read') throw new Error('The fixture requires a collection read');
				expect(
					yield* code(
						hub.register(c, 'p', {
							read: { ...cursor, page: { _tag: 'Limit', limit: 5, after: 'x' } }
						})
					)
				).toBe('invalid');
				yield* disconnect(c);
			})
	);

	it.effect(
		'an answer over 2 MiB errors that view alone; the stream and its other views go on',
		() =>
			Effect.gen(function* () {
				const big = 'x'.repeat(LIVE.subscriptionBytes);
				const { hub, frames, connect, ended } = yield* setup((r) =>
					r.kind === 'get' ? big : null
				);
				const c = yield* connect();
				yield* hub.register(c, 'big', { read: ir.get(cat, 'orders', 'o1') });
				yield* hub.register(c, 'all', { read: ir.read(cat, 'orders', { all: true }) });
				yield* TestClock.adjust(0);
				expect(frames.filter((f) => f.t === 'error')).toEqual([
					expect.objectContaining({ view: 'big', code: 'subscriptionTooLarge' })
				]);
				expect(answers(frames)).toEqual(['all']);
				expect(ended()).toBe(false);
				expect(yield* hub.retained).toBeLessThan(100);
			})
	);

	it.effect('the 501st view on a connection is tooManySubscriptions', () =>
		Effect.gen(function* () {
			const { hub, connect, disconnect } = yield* setup();
			const c = yield* connect();
			for (let i = 0; i < LIVE.perConnection; i++)
				yield* hub.register(c, `v${i}`, { read: ir.get(cat, 'orders', `o${i}`) });
			expect(
				yield* Effect.flip(hub.register(c, 'one-more', { read: ir.get(cat, 'orders', 'x') }))
			).toMatchObject({ code: 'tooManySubscriptions' });
		})
	);

	it.effect(
		'an authority change re-answers; a generation change closes with { release } (rule 66)',
		() =>
			Effect.gen(function* () {
				const { hub, frames, connect, ended } = yield* setup();
				const c = yield* connect();
				yield* hub.register(c, 'all', { read: ir.read(cat, 'orders', { all: true }) });
				yield* TestClock.adjust(0);
				frames.length = 0;
				yield* hub.authorize(c, rep);
				yield* TestClock.adjust(0);
				expect(answers(frames)).toEqual(['all']);
				yield* hub.close('r2');
				yield* TestClock.adjust(0);
				expect(frames.at(-1)).toEqual({ t: 'close', release: 'r2' });
				expect(ended()).toBe(true);
				expect(yield* hub.retained).toBe(0);
			})
	);
});

describe('protocol/wire (rule 32)', () => {
	it('maps outcomes to HTTP and gives public and API-key actors codes only', () => {
		const refused = {
			kind: 'refused',
			code: 'unique',
			message: 'That name is taken.',
			field: 'name'
		} as const;
		expect([
			statusOf({ kind: 'committed', output: null, records: [] }),
			statusOf({ kind: 'pendingApproval', requestId: 'r', records: [] }),
			statusOf({ kind: 'conflict', records: [] }),
			statusOf({ kind: 'unknown', invocation: 'i' }),
			statusOf(refused),
			statusOf({ ...refused, code: 'forbidden' }),
			statusOf({ ...refused, code: 'rateLimited' })
		]).toEqual([200, 202, 409, 504, 422, 403, 429]);
		expect(redact(refused, { kind: 'apiKey', key: 'k' })).toEqual({
			kind: 'refused',
			code: 'unique',
			message: 'unique',
			field: 'name'
		});
		expect(redact(refused, member('u1'))).toBe(refused);
	});
});

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};
const Page = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	next: Schema.NullOr(Schema.String)
});
const observe = Effect.fn('Test.observeClient')(function* <A, E>(stream: Stream.Stream<A, E>) {
	const answers = yield* Queue.unbounded<A>();
	let current: A | undefined;
	const fiber = yield* stream.pipe(
		Stream.runForEach((value) =>
			Effect.gen(function* () {
				current = value;
				yield* Queue.offer(answers, value);
			})
		),
		Effect.forkScoped
	);
	return {
		current: () => present(current),
		next: Queue.take(answers),
		fiber,
		stop: Fiber.interrupt(fiber)
	};
});
const client = Effect.fn('Test.client')(function* (config: Partial<BoltConfig> = {}) {
	const scope = yield* Scope.make();
	const close = Scope.close(scope, Exit.void);
	yield* Effect.addFinalizer(() => close);
	const sources: EventSourceLike[] = [],
		closed: number[] = [],
		registered: LiveBody[] = [];
	const opened = yield* Queue.unbounded<EventSourceLike>();
	const registration = yield* Queue.unbounded<LiveBody>();
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		const body = Schema.decodeUnknownSync(Schema.fromJsonString(LiveBody))(
			await new Response(init?.body).text()
		);
		registered.push(body);
		Queue.offerUnsafe(registration, body);
		return Response.json({ errors: [] });
	};
	const bolt = yield* createBolt({
		actor: null,
		locale: 'en',
		base: 'http://localhost',
		fetch,
		...config,
		openStream: () => {
			const index = sources.length;
			const source: EventSourceLike = {
				onmessage: null,
				onerror: null,
				close: () => {
					closed.push(index);
				}
			};
			sources.push(source);
			Queue.offerUnsafe(opened, source);
			return source;
		}
	}).pipe(Effect.provideService(Scope.Scope, scope));
	const statuses: SyncStatus[] = [];
	const status = yield* observe(bolt.sync);
	yield* status.next;
	const tracked = yield* bolt.sync.pipe(
		Stream.runForEach((value) =>
			Effect.sync(() => {
				statuses.push(value);
			})
		),
		Effect.forkScoped
	);
	void tracked;
	// Opening enqueues the source before the stream installs its callbacks.
	const push = (frame: Frame) =>
		TestClock.adjust(0).pipe(
			Effect.andThen(
				Effect.sync(() =>
					present(present(sources.at(-1)).onmessage)(
						new MessageEvent('message', { data: JSON.stringify(frame) })
					)
				)
			)
		);
	const drop = Effect.sync(() => present(sources.at(-1)).onerror?.(new Event('error')));
	const settle = TestClock.adjust(0);
	return {
		bolt,
		scope,
		close,
		sources,
		closed,
		registered,
		registration: Queue.take(registration),
		opened: Queue.take(opened),
		status,
		statuses,
		push,
		drop,
		settle
	};
});
const midpoint = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	work.pipe(
		Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.5 })
	);

describe('$bolt client without a server', () => {
	it.effect(
		'a live consumer can await an act while every other consumer observes its final repaint',
		() =>
			Effect.gen(function* () {
				const written = {
					id: '0199a000-0000-7000-8000-000000000001',
					title: 'from live',
					revision: 1
				};
				const finalShown = yield* Deferred.make<void>();
				const allowAcknowledgement = yield* Deferred.make<void>();
				const completed = yield* Deferred.make<void>();
				const selfObserved = yield* Deferred.make<void>();
				const ready = yield* Deferred.make<void>();
				const fetch: typeof globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					if (new URL(request.url).pathname.endsWith('/live')) return Response.json({ errors: [] });
					const body = Schema.decodeUnknownSync(ActBody)(await request.json());
					expect(body).toMatchObject({ callable: 'orders.create', input: { title: 'from live' } });
					const frame: Frame = {
						t: 'patch',
						view: 'v1',
						v: 1,
						ops: [{ op: 'upsert', index: 0, row: written }]
					};
					present(present(transportClient.sources.at(-1)).onmessage)(
						new MessageEvent('message', { data: JSON.stringify(frame) })
					);
					return Response.json({
						outcome: {
							kind: 'committed',
							output: null,
							records: [{ collection: 'orders', id: written.id, revision: 1 }]
						},
						v: 1
					});
				};
				const transportClient = yield* client({ fetch, uuid: () => 'live-act' });
				let other: typeof Page.Type | undefined;
				const final = (value: typeof Page.Type) =>
					value.rows.length === 1 && value.rows[0]?.['id'] === written.id;
				yield* transportClient.bolt
					.live<typeof Page.Type>(transportClient.bolt.read('orders', { all: true }))
					.pipe(
						Stream.runForEach((value) =>
							Effect.gen(function* () {
								other = value;
								if (value.rows.length === 0) yield* Deferred.succeed(ready, undefined);
								if (final(value)) {
									yield* Deferred.succeed(finalShown, undefined);
									yield* Deferred.await(allowAcknowledgement);
								}
							})
						),
						Effect.forkScoped
					);
				yield* transportClient.opened;
				yield* transportClient.push({ t: 'hello', conn: 'live-callback', v: 0 });
				yield* transportClient.push({
					t: 'answer',
					view: 'v1',
					v: 0,
					value: { rows: [], next: null }
				});
				yield* Deferred.await(ready);
				let invoked = false;
				yield* transportClient.bolt
					.live<typeof Page.Type>(transportClient.bolt.read('orders', { all: true }))
					.pipe(
						Stream.runForEach((value) =>
							Effect.gen(function* () {
								if (!invoked) {
									invoked = true;
									const result = yield* transportClient.bolt.act('orders.create', {
										title: 'from live'
									});
									expect(result).toMatchObject({
										kind: 'committed',
										records: [{ collection: 'orders', id: written.id, revision: 1 }]
									});
									expect(present(other).rows).toEqual([written]);
									yield* Deferred.succeed(completed, undefined);
								}
								if (final(value)) yield* Deferred.succeed(selfObserved, undefined);
							})
						),
						Effect.forkScoped
					);
				yield* Deferred.await(finalShown);
				expect((yield* Deferred.poll(completed))._tag).toBe('None');
				yield* Deferred.succeed(allowAcknowledgement, undefined);
				yield* Deferred.await(completed);
				yield* Deferred.await(selfObserved);
				expect(present(other).rows).toEqual([written]);
			})
	);
	it.effect(
		'late events from a closed stream neither replay notice arrivals nor retire its replacement',
		() =>
			midpoint(
				Effect.gen(function* () {
					const sources: EventSourceLike[] = [],
						closed: number[] = [],
						frames: Frame[] = [];
					const received = yield* Queue.unbounded<Frame>();
					const open = () => {
						const index = sources.length;
						const source: EventSourceLike = {
							onmessage: null,
							onerror: null,
							close: () => {
								closed.push(index);
							}
						};
						sources.push(source);
						return source;
					};
					const fiber = yield* liveStream(open).pipe(
						Stream.runForEach((frame) =>
							Effect.sync(() => {
								frames.push(frame);
								Queue.offerUnsafe(received, frame);
							})
						),
						Effect.forkScoped
					);
					yield* TestClock.adjust(0);
					const first = present(sources[0]);
					first.onmessage?.(
						new MessageEvent('message', {
							data: JSON.stringify({ t: 'hello', conn: 'old', v: 10 })
						})
					);
					yield* Queue.take(received);
					first.onerror?.(new Event('error'));
					yield* TestClock.adjust(500);
					const next = present(sources[1]);
					next.onmessage?.(
						new MessageEvent('message', { data: JSON.stringify({ t: 'hello', conn: 'new', v: 0 }) })
					);
					yield* Queue.take(received);
					first.onmessage?.(
						new MessageEvent('message', {
							data: JSON.stringify({
								t: 'answer',
								view: 'v1',
								v: 11,
								value: { rows: [] },
								arrivals: [{ id: 'old-notice' }]
							})
						})
					);
					first.onerror?.(new Event('error'));
					yield* TestClock.adjust(0);
					expect(frames).toEqual([
						{ t: 'hello', conn: 'old', v: 10 },
						{ t: 'hello', conn: 'new', v: 0 }
					]);
					expect(closed).toEqual([0]);
					expect(fiber.pollUnsafe()).toBeUndefined();
					yield* Fiber.interrupt(fiber);
					expect(closed).toEqual([0, 1]);
				})
			)
	);
	it.effect(
		'notifies committed arrivals once across inbox views, without boot or reconnect history, and recovers after sequence reset',
		() =>
			Effect.gen(function* () {
				const arrived: Json[] = [];
				const c = yield* client({
					onNotice: (notice) => {
						arrived.push(notice['id'] ?? null);
					}
				});
				const query = { read: { m: 'inbox' as const, a: [] } };
				const first = yield* observe(c.bolt.live<unknown>(query));
				const second = yield* observe(c.bolt.live<unknown>(query, { every: '10s' }));
				yield* c.opened;
				const notice = (id: string) => ({ id, title: id, read: false });
				yield* c.push({ t: 'hello', conn: 'first', v: 0 });
				yield* c.registration;
				yield* c.push({
					t: 'answer',
					view: 'v1',
					v: 0,
					value: { rows: [notice('historical')], unread: 1 }
				});
				yield* first.next;
				expect(arrived).toEqual([]);
				yield* c.push({
					t: 'answer',
					view: 'v1',
					v: 1,
					value: { rows: [notice('fresh')], unread: 2 },
					arrivals: [notice('fresh')]
				});
				yield* first.next;
				yield* c.push({
					t: 'answer',
					view: 'v2',
					v: 1,
					value: { rows: [notice('fresh')], unread: 2 },
					arrivals: [notice('fresh')]
				});
				yield* second.next;
				expect(arrived).toEqual(['fresh']);
				yield* c.push({ t: 'hello', conn: 'reconnect', v: 9 });
				yield* c.registration;
				yield* c.push({
					t: 'answer',
					view: 'v1',
					v: 9,
					value: { rows: [notice('missed-while-offline')], unread: 3 }
				});
				yield* first.next;
				expect(arrived).toEqual(['fresh']);
				yield* c.push({
					t: 'answer',
					view: 'v1',
					v: 10,
					value: { rows: [notice('after-reconnect')], unread: 4 },
					arrivals: [notice('after-reconnect')]
				});
				yield* first.next;
				yield* c.push({ t: 'hello', conn: 'server-restart', v: 0 });
				yield* c.registration;
				yield* c.push({ t: 'answer', view: 'v1', v: 0, value: { rows: [], unread: 4 } });
				yield* first.next;
				yield* c.push({
					t: 'answer',
					view: 'v1',
					v: 1,
					value: { rows: [notice('after-restart')], unread: 5 },
					arrivals: [notice('after-restart')]
				});
				yield* first.next;
				expect(arrived).toEqual(['fresh', 'after-reconnect', 'after-restart']);
				yield* c.close;
			})
	);
	it.effect(
		'a refused write paints while in flight and un-paints; a network failure is unknown with the key (rules 32, 67)',
		() =>
			Effect.gen(function* () {
				let during = -1,
					offline = false;
				const fetched = yield* Queue.unbounded<void>();
				const response = yield* Deferred.make<Response>();
				const painted = yield* Deferred.make<void>();
				const run = yield* FiberSet.makeRuntimePromise();
				const fetch: typeof globalThis.fetch = async (url, init) => {
					if (String(url).endsWith('/live')) return Response.json({ errors: [] });
					if (offline) throw new TypeError('offline');
					return run(
						Effect.gen(function* () {
							yield* Deferred.await(painted);
							during = view.current().rows.length;
							yield* Queue.offer(fetched, undefined);
							return yield* Deferred.await(response);
						}),
						init?.signal == null ? {} : { signal: init.signal }
					);
				};
				const c = yield* client({ fetch, uuid: () => 'k1' });
				const view = yield* observe(
					c.bolt.live<typeof Page.Type>(c.bolt.read('orders', { all: true }))
				);
				yield* c.opened;
				yield* c.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* c.push({ t: 'answer', view: 'v1', v: 0, value: { rows: [order()], next: null } });
				yield* view.next;
				const write = yield* c.bolt
					.act('orders.create', { title: 'x' })
					.pipe(Effect.flip, Effect.forkScoped);
				yield* view.next;
				yield* Deferred.succeed(painted, undefined);
				yield* Queue.take(fetched);
				yield* Deferred.succeed(
					response,
					Response.json(
						{ outcome: { kind: 'refused', code: 'forbidden', message: 'No.' }, v: 0 },
						{ status: 403 }
					)
				);
				expect(yield* Fiber.join(write)).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				yield* view.next;
				expect([during, view.current().rows.length]).toEqual([2, 1]);
				offline = true;
				expect(yield* Effect.flip(c.bolt.act('orders.create', { title: 'x' }))).toMatchObject({
					_tag: 'ActUnknown',
					invocation: 'k1'
				});
				yield* c.settle;
				expect(view.current().rows).toHaveLength(1);
				expect(c.bolt.t('hello {name}', { name: 'Ada' })).toBe('hello Ada');
				yield* view.stop;
			})
	);
	it.effect(
		'applies patches in lane order, ignores a stale one and re-registers a view a patch does not fit (rule 65)',
		() =>
			Effect.gen(function* () {
				const c = yield* client();
				const view = yield* observe(
					c.bolt.live<typeof Page.Type>(c.bolt.read('orders', { all: true }))
				);
				const titles = () => view.current().rows.map((row) => row['title']);
				yield* c.opened;
				yield* c.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* c.registration;
				yield* c.push({ t: 'answer', view: 'v1', v: 1, value: { rows: [order()], next: null } });
				yield* view.next;
				yield* c.push({
					t: 'patch',
					view: 'v1',
					v: 2,
					ops: [
						{ op: 'upsert', index: 0, row: order({ id: 'o0', title: 'chair' }) },
						{ op: 'upsert', index: 1, row: order({ title: 'lamp' }) }
					]
				});
				yield* view.next;
				expect(titles()).toEqual(['chair', 'lamp']);
				yield* c.push({ t: 'patch', view: 'v1', v: 2, ops: [{ op: 'remove', id: 'o0' }] });
				yield* c.settle;
				expect(titles()).toEqual(['chair', 'lamp']);
				c.registered.length = 0;
				yield* c.push({
					t: 'patch',
					view: 'v1',
					v: 3,
					ops: [{ op: 'upsert', index: 5, row: order({ id: 'o9' }) }]
				});
				yield* c.registration;
				expect(titles()).toEqual(['chair', 'lamp']);
				expect(c.registered).toEqual([
					{
						conn: 'c1',
						drop: [],
						add: [{ view: 'v1', read: { m: 'read', a: ['orders', { all: true }] } }]
					}
				]);
				yield* view.stop;
			})
	);
	it.effect(
		'a dropped link reports down, retries on a doubling backoff, and the next hello re-answers every view; scope closure retires it',
		() =>
			midpoint(
				Effect.gen(function* () {
					const c = yield* client();
					const view = yield* observe(
						c.bolt.live<typeof Page.Type>(c.bolt.read('orders', { all: true }))
					);
					yield* c.opened;
					expect(c.status.current()).toBe('connecting');
					yield* c.push({ t: 'hello', conn: 'c1', v: 0 });
					yield* c.registration;
					yield* c.push({ t: 'answer', view: 'v1', v: 0, value: { rows: [order()], next: null } });
					yield* view.next;
					expect(c.status.current()).toBe('live');
					expect(c.statuses.at(-1)).toBe('live');
					yield* c.drop;
					yield* c.settle;
					expect(c.closed).toEqual([0]);
					expect(c.status.current()).toBe('connecting');
					yield* TestClock.adjust(499);
					expect(c.sources).toHaveLength(1);
					yield* TestClock.adjust(1);
					yield* c.opened;
					expect(c.sources).toHaveLength(2);
					yield* c.drop;
					yield* TestClock.adjust(999);
					expect(c.sources).toHaveLength(2);
					yield* TestClock.adjust(1);
					yield* c.opened;
					expect(c.sources).toHaveLength(3);
					yield* c.push({ t: 'hello', conn: 'c2', v: 4 });
					yield* c.registration;
					yield* c.push({
						t: 'answer',
						view: 'v1',
						v: 4,
						value: { rows: [order({ id: 'o2' })], next: null }
					});
					yield* view.next;
					expect(c.registered.map((body) => body.conn)).toEqual(['c1', 'c2']);
					expect(present(c.registered[1]).add?.map((item) => item.view)).toEqual(['v1']);
					expect(present(view.current().rows[0])['id']).toBe('o2');
					expect(c.statuses.at(-1)).toBe('live');
					yield* c.close;
					yield* c.settle;
					expect(c.closed).toEqual([0, 1, 2]);
					expect(c.status.current()).toBe('idle');
					yield* view.stop;
				})
			)
	);
	it.effect(
		'a drop backs off from 0.5 s ±50% and wakes on online; background tabs keep retrying',
		() =>
			Effect.gen(function* () {
				let random = 0.5;
				const listeners: Record<string, () => void> = {};
				const signals = {
					hidden: false,
					addEventListener: (type: string, run: () => void) => {
						listeners[type] = run;
					},
					removeEventListener: (type: string) => {
						delete listeners[type];
					}
				};
				const test = Effect.gen(function* () {
					const c = yield* client({ signals });
					const view = yield* observe(c.bolt.live<unknown>(c.bolt.read('orders', { all: true })));
					yield* c.opened;
					let conns = 0;
					const hello = () =>
						c
							.push({ t: 'hello', conn: `c${++conns}`, v: conns })
							.pipe(Effect.andThen(c.registration));
					yield* hello();
					const drop = Effect.gen(function* () {
						const down = c.sources.length;
						yield* c.drop;
						yield* c.settle;
						expect(c.status.current()).toBe('connecting');
						return down;
					});
					const after = (ms: number, want: number) =>
						Effect.gen(function* () {
							const opening = want > c.sources.length;
							yield* TestClock.adjust(ms);
							if (opening) yield* c.opened;
							expect(c.sources).toHaveLength(want);
						});
					random = 0;
					const low = yield* drop;
					yield* after(249, low);
					yield* after(1, low + 1);
					random = 0.999;
					const high = yield* drop;
					yield* after(1498, high);
					yield* after(1, high + 1);
					random = 0.5;
					for (const wait of [2000, 4000, 8000, 16000, 30000]) {
						const down = yield* drop;
						yield* after(wait - 1, down);
						yield* after(1, down + 1);
					}
					const slept = yield* drop;
					present(listeners['online'])();
					yield* c.opened;
					expect(c.sources).toHaveLength(slept + 1);
					const capped = yield* drop;
					signals.hidden = true;
					present(listeners['visibilitychange'])();
					yield* c.settle;
					yield* after(30000, capped + 1);
					expect(c.closed).toHaveLength(capped);
					expect(c.status.current()).toBe('connecting');
					signals.hidden = false;
					listeners['visibilitychange']?.();
					yield* c.settle;
					expect(c.sources).toHaveLength(capped + 1);
					yield* hello();
					expect(c.registered.map((body) => body.conn)).toEqual(
						Array.from({ length: conns }, (_, i) => `c${i + 1}`)
					);
					expect(c.registered.at(-1)?.add?.map((item) => item.view)).toEqual(['v1']);
					expect(c.status.current()).toBe('live');
					yield* view.stop;
				});
				yield* test.pipe(
					Effect.provideService(Random.Random, {
						nextIntUnsafe: () => 0,
						nextDoubleUnsafe: () => random
					})
				);
			})
	);
	it.effect(
		'a closed client holds nothing: its signal listeners come off and no view grace timer stays armed',
		() =>
			midpoint(
				Effect.gen(function* () {
					const listening = new Set<string>();
					const signals = {
						hidden: false,
						addEventListener: (type: string) => {
							listening.add(type);
						},
						removeEventListener: (type: string) => {
							listening.delete(type);
						}
					};
					const c = yield* client({ signals });
					const view = yield* observe(c.bolt.live<unknown>(c.bolt.read('orders', { all: true })));
					yield* c.opened;
					yield* c.drop;
					yield* c.settle;
					expect([...listening].sort()).toEqual(['online', 'visibilitychange']);
					yield* c.close;
					yield* view.stop;
					expect(listening.size).toBe(0);
					expect(c.closed).toHaveLength(1);
					yield* TestClock.adjust(300000);
					expect(c.sources).toHaveLength(1);
				})
			)
	);
	it.effect('all queries share one connection that remains live in a hidden tab', () =>
		Effect.gen(function* () {
			const signals = { hidden: true, addEventListener: () => {} };
			const c = yield* client({ signals });
			const first = yield* observe(c.bolt.live<unknown>(c.bolt.read('orders', { all: true })));
			yield* c.opened;
			expect(c.sources).toHaveLength(1);
			yield* TestClock.adjust(300000);
			expect(c.sources).toHaveLength(1);
			const next = yield* observe(
				c.bolt.live<unknown>(c.bolt.read('orders', { where: { region: 'north' } }))
			);
			yield* c.settle;
			expect(c.sources).toHaveLength(1);
			yield* TestClock.adjust(300000);
			expect(c.sources).toHaveLength(1);
			yield* first.stop;
			yield* next.stop;
		})
	);
	it.effect(
		'a missing server connection reconnects, and a late old registration cannot poison recovered views',
		() =>
			Effect.gen(function* () {
				const pending: ((response: Response) => void)[] = [];
				const requested = yield* Queue.unbounded<void>();
				const fetch: typeof globalThis.fetch = () =>
					new Promise<Response>((resolve) => {
						pending.push(resolve);
						Queue.offerUnsafe(requested, undefined);
					});
				const c = yield* client({ fetch });
				const view = yield* observe(c.bolt.live<unknown>(c.bolt.read('orders', { all: true })));
				yield* c.opened;
				yield* c.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* Queue.take(requested);
				const another = yield* observe(
					c.bolt.live<unknown>(c.bolt.read('orders', { where: { region: 'north' } }))
				);
				yield* Queue.take(requested);
				const gone = () =>
					Response.json({
						errors: [{ view: 'v1', code: 'notFound', message: 'the live connection is gone' }]
					});
				present(pending[0])(gone());
				yield* c.opened;
				expect(view.fiber.pollUnsafe()).toBeUndefined();
				yield* c.push({ t: 'hello', conn: 'c1', v: 1 });
				yield* Queue.take(requested);
				yield* c.push({ t: 'answer', view: 'v1', v: 1, value: { rows: [order()], next: null } });
				yield* view.next;
				present(pending[1])(gone());
				present(pending[2])(Response.json({ errors: [] }));
				yield* c.settle;
				expect(view.fiber.pollUnsafe()).toBeUndefined();
				expect(c.sources).toHaveLength(2);
				expect(c.status.current()).toBe('live');
				yield* another.stop;
				yield* c.close;
			})
	);
	it.effect('one committed change reaches subscriptions on both tab connections', () =>
		Effect.gen(function* () {
			const { hub } = yield* setup(() => ({ rows: [order()], next: null }));
			const tabs: Frame[][] = [[], []];
			for (const frames of tabs) {
				const conn = (yield* connection(hub, admin, frames)).id;
				yield* hub.register(conn, 'v1', { read: ir.read(cat, 'orders', { all: true }) });
				yield* TestClock.adjust(0);
				frames.length = 0;
			}
			hub.publish([cap(order(), order({ title: 'updated in another tab' }))]);
			yield* hub.settled;
			yield* TestClock.adjust(0);
			for (const frames of tabs)
				expect(frames).toContainEqual(expect.objectContaining({ t: 'patch', view: 'v1' }));
		})
	);
});

it.effect('a query refresh waits for its debounce window under the test clock', () =>
	Effect.gen(function* () {
		const { hub, connect, asked } = yield* setup(() => null);
		const id = yield* connect();
		yield* hub.register(id, 'query', {
			read: { kind: 'query', collection: 'orders', query: 'open', input: null },
			on: ['orders']
		});
		asked.length = 0;
		hub.publish([cap(null, order())]);
		yield* hub.settled;
		yield* TestClock.adjust(0);
		yield* TestClock.adjust(LIVE.onDebounceMs - 1);
		expect(asked).toHaveLength(0);
		yield* TestClock.adjust(1);
		expect(asked).toHaveLength(1);
	})
);
