// One live connection per browser: the tab holding the Web Lock owns every tab's views (BroadcastChannel + Web Locks,
// both Node's own here), and equivalent views are one registration on its connection.
import { afterEach, describe, expect, it, vi } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Schema, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { canonical, sha256_hex } from '@norbital-ai/store';
import { create_bolt, type BoltConfig } from '../src/page/bolt.ts';
import { sharedSource, type EventSourceLike, type Hold } from '../src/page/stream.ts';
import type { EngineActor } from '../src/engine/contracts.ts';
import { Frame, LiveBody, type WireRead } from '../src/protocol/schema.ts';

/** Every tab's frame or connection is a change; a check waits on changes until it holds. */
const changes = new EventTarget();
const changed = () => changes.dispatchEvent(new Event('change'));
const heard_until = (check: () => boolean) =>
	Effect.promise(async () => {
		while (!check())
			await new Promise((resolve) => changes.addEventListener('change', resolve, { once: true }));
	});
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));

/** A tab: the stream it would open when it leads, and every frame it hears. It relays as its client would. */
const tab = (url: string) => {
	const heard: string[] = [];
	const opened: EventSourceLike[] = [];
	const source = sharedSource(url, () => {
		const stream: EventSourceLike = { onmessage: null, onerror: null, close: () => undefined };
		opened.push(stream);
		changed();
		return stream;
	});
	source.onmessage = (event) => {
		heard.push(event.data);
		if (source.leads) source.relay(event.data, decodeFrame(event.data).t === 'hello');
		changed();
	};
	const send = (data: string) =>
		opened.at(-1)?.onmessage?.(new MessageEvent('message', { data }));
	return { source, heard, opened, send };
};

// `unstubGlobals` restores before each test only: a stubbed `window` would outlive this file's last test and reach the
// next file's suite setup in this worker (PGlite then reads `window.location` and fails to open)
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('shared live connection', () => {
	it.live('one tab connects; the others hear what it relays; the next tab leads when it goes', () =>
		Effect.gen(function* () {
			const url = `/t${Math.random()}/__bolt/live`;
			const a = tab(url),
				b = tab(url);
			yield* heard_until(() => a.opened.length === 1);
			a.send('{"t":"hello","conn":"c1","v":0}');
			a.send('{"t":"v","v":1}');
			yield* heard_until(() => b.heard.length === 2);
			expect(a.heard).toEqual(b.heard);
			expect(b.opened).toEqual([]);
			// a tab that joins later is answered the leader's hello
			const c = tab(url);
			yield* heard_until(() => c.heard.length === 1);
			expect(c.heard).toEqual(['{"t":"hello","conn":"c1","v":0}']);
			// only the asker: a tab that heard the hello attaches its views once
			a.send('{"t":"v","v":2}');
			yield* heard_until(() => b.heard.length === 3 && c.heard.length === 2);
			expect(b.heard).toEqual(a.heard);
			a.source.close();
			yield* heard_until(() => b.opened.length + c.opened.length === 1);
			const next = b.opened.length === 1 ? b : c;
			next.send('{"t":"hello","conn":"c2","v":1}');
			yield* heard_until(() => b.heard.at(-1) === c.heard.at(-1));
			expect(b.heard.at(-1)).toBe('{"t":"hello","conn":"c2","v":1}');
			b.source.close();
			c.source.close();
		})
	);

	it.live('a tab that hears a frame before its answer still takes the hello it asked for', () =>
		Effect.gen(function* () {
			const url = `/t${Math.random()}/__bolt/live`;
			const a = tab(url);
			yield* heard_until(() => a.opened.length === 1);
			a.send('{"t":"hello","conn":"c1","v":0}');
			a.send('{"t":"v","v":1}');
			// the leader relays its next frame before the joining tab's question reaches it
			const b = tab(url);
			a.send('{"t":"v","v":2}');
			yield* heard_until(() => b.heard.includes('{"t":"hello","conn":"c1","v":0}'));
			a.source.close();
			b.source.close();
		})
	);

	it.live('the leader hears holds and sends one tab a frame; a closed tab passes it its lock', () =>
		Effect.gen(function* () {
			const url = `/t${Math.random()}/__bolt/live`;
			const a = tab(url),
				b = tab(url),
				c = tab(url);
			yield* heard_until(() => a.opened.length === 1);
			const holds: Hold[] = [];
			a.source.onhold = (hold) => {
				holds.push(hold);
				changed();
			};
			a.send('{"t":"hello","conn":"c1","v":0}');
			yield* heard_until(() => b.heard.length === 1 && c.heard.length === 1);
			const read: WireRead = { m: 'query', a: [{ orders: {} }] };
			b.source.hold([{ view: 's1', read }], []);
			b.source.hold([], ['s1']);
			yield* heard_until(() => holds.length === 2);
			const first = holds[0];
			const id = first !== undefined && 'tab' in first ? first.tab : '';
			expect(holds).toEqual([
				{ tab: id, attach: [{ view: 's1', read }] },
				{ tab: id, detach: ['s1'] }
			]);
			// a frame to one tab reaches it alone, in order with what the leader relays after it
			a.source.send(id, '{"t":"v","v":5}');
			a.send('{"t":"v","v":6}');
			yield* heard_until(() => b.heard.length === 3 && c.heard.length === 2);
			expect(b.heard.slice(1)).toEqual(['{"t":"v","v":5}', '{"t":"v","v":6}']);
			expect(c.heard.slice(1)).toEqual(['{"t":"v","v":6}']);
			// no poll: the attached tab's own lock passes to the leader when it goes
			b.source.close();
			yield* heard_until(() => holds.length === 3);
			expect(holds[2]).toEqual({ gone: id });
			a.source.close();
			c.source.close();
		})
	);
});

const present = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing fixture value');
	return value;
};
/** Lets the event loop take up to `limit` turns while `check` fails: channel messages and lock grants are tasks. */
const turns = (check: () => boolean, limit: number) =>
	Effect.promise(async () => {
		for (let turn = 0; turn < limit && !check(); turn++)
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
const until = (check: () => boolean) =>
	turns(check, 10_000).pipe(Effect.andThen(Effect.sync(() => expect(check()).toBe(true))));
/** Passes a grace at a time until `check` holds: what arms each wait (a lock grant, a detach) lands on the event loop. */
const graces = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let grace = 0; grace < 20 && !check(); grace++) {
			yield* TestClock.adjust('30 seconds');
			yield* turns(check, 100);
		}
		expect(check()).toBe(true);
	});
const member = (id: string): EngineActor => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [],
	team_path: [],
	admin: false,
	party: null
});
const Page = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	next: Schema.NullOr(Schema.String)
});
const Orders = Schema.Struct({ orders: Page });
const orders: { readonly read: WireRead } = { read: { m: 'query', a: [{ orders: {} }] } };
const north: { readonly read: WireRead } = {
	read: { m: 'query', a: [{ orders: { where: { region: { eq: 'north' } } } }] }
};
const customers: { readonly read: WireRead } = { read: { m: 'query', a: [{ customers: {} }] } };
const page = (...ids: string[]) => ({
	orders: { rows: ids.map((id) => ({ id, title: id })), next: null }
});
const upsert = (id: string) =>
	({ op: 'upsert', path: ['orders'], index: 0, row: { id, title: id } }) as const;
/** The views a connection holds after every registration so far, and the most it ever held. */
const held = (registered: readonly LiveBody[], conn: string) => {
	const views = new Set<string>();
	let most = 0;
	for (const body of registered)
		if (body.conn === conn) {
			for (const add of body.add ?? []) views.add(add.view);
			for (const view of body.drop ?? []) views.delete(view);
			most = Math.max(most, views.size);
		}
	return { views, most };
};
/** The id a registration gave `read`, by its canonical form. */
const idOf = (registered: readonly LiveBody[], read: WireRead, conn = 'c1') =>
	present(
		registered
			.filter((body) => body.conn === conn)
			.flatMap((body) => body.add ?? [])
			.find((add) => canonical(add.read) === canonical(read))
	).view;

let browsers = 0;
/**
 * One browser's tabs in this process: each is a client over Node's BroadcastChannel and Web Locks, and the leading one
 * opens the stubbed `EventSource`. The fake host records every live registration; `push` sends a frame down the open
 * stream.
 */
const browser = Effect.fn('Test.browser')(function* (
	act: (request: Request) => Promise<Response> = async () => Response.json({ errors: [] })
) {
	const base = `http://tabs-${++browsers}.test`;
	const sources: Source[] = [];
	const registered: LiveBody[] = [];
	class Source implements EventSourceLike {
		onmessage: EventSourceLike['onmessage'] = null;
		onerror: EventSourceLike['onerror'] = null;
		closed = false;
		constructor() {
			sources.push(this);
		}
		close() {
			this.closed = true;
		}
	}
	vi.stubGlobal('window', {});
	vi.stubGlobal('EventSource', Source);
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (!new URL(request.url).pathname.endsWith('/live')) return act(request);
		registered.push(Schema.decodeUnknownSync(LiveBody)(await request.json()));
		return Response.json({ errors: [] });
	};
	const open = () => sources.find((source) => !source.closed);
	const tab = Effect.fn('Test.tab')(function* (config: Partial<BoltConfig> = {}) {
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const bolt = yield* create_bolt({
			actor: null,
			policies: [],
			locale: 'en',
			base,
			fetch,
			...config,
			operation_outputs: { automations: {} }
		}).pipe(Effect.provideService(Scope.Scope, scope));
		/** A consumer on this tab: what it last rendered, everything it rendered, and its fiber. */
		const observe = <A>(query: { readonly read: WireRead }, schema: Schema.Decoder<A>) =>
			Effect.gen(function* () {
				let current: A | undefined;
				const seen: A[] = [];
				const fiber = yield* bolt.observe(query, schema).pipe(
					Stream.runForEach((value) =>
						Effect.sync(() => {
							current = value;
							seen.push(value);
						})
					),
					Effect.forkIn(scope)
				);
				return { current: () => current, seen, fiber };
			});
		return { bolt, observe, close: Scope.close(scope, Exit.void) };
	});
	return {
		tab,
		registered,
		sources,
		open,
		/** Waits for the leading tab's stream, and sends it a frame. */
		push: (frame: Frame) =>
			until(() => open() !== undefined).pipe(
				Effect.andThen(
					Effect.sync(() =>
						present(open()).onmessage?.(
							new MessageEvent('message', { data: JSON.stringify(frame) })
						)
					)
				)
			)
	};
});
const shows = <A>(
	consumers: readonly { readonly current: () => A | undefined }[],
	value: unknown
) =>
	until(() =>
		consumers.every((consumer) => JSON.stringify(consumer.current()) === JSON.stringify(value))
	);
const failure = (fiber: Fiber.Fiber<void, unknown>) => {
	const exit = fiber.pollUnsafe();
	return exit !== undefined && Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
};

describe('live views shared between tabs', () => {
	it.effect(
		'equivalent tabs hold one registration; a third adds none, and all render one image',
		() =>
			Effect.gen(function* () {
				const b = yield* browser();
				const one = yield* (yield* b.tab()).observe(orders, Orders);
				const two = yield* (yield* b.tab()).observe(orders, Orders);
				yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* until(() => b.registered.length === 1);
				const view = idOf(b.registered, orders.read);
				expect(b.registered).toEqual([
					{ conn: 'c1', drop: [], add: [{ view, read: orders.read }] }
				]);
				yield* b.push({ t: 'answer', view, v: 1, value: page('o1') });
				yield* shows([one, two], page('o1'));
				// a later tab is sent the leader's image: no registration, no read
				const three = yield* (yield* b.tab()).observe(orders, Orders);
				yield* shows([three], page('o1'));
				yield* b.push({ t: 'delta', view, v: 2, ops: [upsert('o2')] });
				yield* shows([one, two, three], page('o2', 'o1'));
				expect(b.registered).toHaveLength(1);
				expect(b.sources).toHaveLength(1);
			})
	);

	it.effect(
		'different reads and authorities never share; a revoked view fails on every tab holding it',
		() =>
			Effect.gen(function* () {
				const b = yield* browser();
				const ada = yield* b.tab({ actor: member('ada') });
				const hers = yield* ada.observe(orders, Orders);
				yield* until(() => b.open() !== undefined);
				// the same browser after another person signs in
				const bob = yield* b.tab({ actor: member('bob') });
				const his = yield* bob.observe(orders, Orders);
				const northern = yield* bob.observe(north, Orders);
				yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* until(() => held(b.registered, 'c1').views.size === 3);
				// the leader's own registration comes first; bob's views are registered for him, under ids of their own
				const first = present(b.registered[0]?.add?.[0]).view;
				const other = idOf(b.registered, north.read);
				const theirs = present(
					b.registered
						.flatMap((body) => body.add ?? [])
						.find((add) => add.view !== first && canonical(add.read) === canonical(orders.read))
				).view;
				expect(new Set([first, theirs, other]).size).toBe(3);
				yield* b.push({ t: 'answer', view: first, v: 1, value: page('a1') });
				yield* b.push({ t: 'answer', view: theirs, v: 1, value: page('b1') });
				yield* b.push({ t: 'answer', view: other, v: 1, value: page('n1') });
				yield* shows([hers], page('a1'));
				yield* shows([his], page('b1'));
				yield* shows([northern], page('n1'));
				expect(his.seen).toEqual([page('b1')]);
				// another tab of the same person shares bob's view
				const again = yield* (yield* b.tab({ actor: member('bob') })).observe(orders, Orders);
				yield* shows([again], page('b1'));
				expect(held(b.registered, 'c1').views.size).toBe(3);
				yield* b.push({ t: 'error', view: theirs, code: 'forbidden', message: 'revoked' });
				yield* until(() => failure(his.fiber) !== undefined && failure(again.fiber) !== undefined);
				expect(failure(his.fiber)).toMatchObject({ _tag: 'ReadFailed', code: 'forbidden' });
				expect(failure(again.fiber)).toMatchObject({ _tag: 'ReadFailed', code: 'forbidden' });
				expect(hers.fiber.pollUnsafe()).toBeUndefined();
			})
	);

	it.effect(
		"a tab joining during another tab's write takes the server's image, never the writer's paint",
		() =>
			Effect.gen(function* () {
				let commit: ((response: Response) => void) | undefined;
				const b = yield* browser(() => new Promise<Response>((resolve) => (commit = resolve)));
				const writer = yield* b.tab();
				const mine = yield* writer.observe(orders, Orders);
				yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* until(() => b.registered.length === 1);
				const view = idOf(b.registered, orders.read);
				yield* b.push({ t: 'answer', view, v: 1, value: page('o1') });
				yield* shows([mine], page('o1'));
				const write = yield* writer.bolt
					.act({ 'orders.create': [{ title: 'o2' }] })
					.pipe(Effect.forkScoped);
				yield* until(() => mine.current()?.orders.rows.length === 2 && commit !== undefined);
				const joiner = yield* (yield* b.tab()).observe(orders, Orders);
				yield* shows([joiner], page('o1'));
				yield* b.push({ t: 'delta', view, v: 2, ops: [upsert('o2')] });
				present(commit)(
					Response.json({
						outcome: {
							kind: 'committed',
							output: { 'orders.create': null },
							records: [{ model: 'orders', id: 'o2', revision: 1 }]
						},
						v: 2
					})
				);
				expect(yield* Fiber.join(write)).toMatchObject({ kind: 'committed' });
				yield* shows([mine, joiner], page('o2', 'o1'));
				expect(
					joiner.seen
						.flatMap((value) => value.orders.rows)
						.some((row) => String(row['id']).startsWith('pending:'))
				).toBe(false);
				expect(b.registered).toHaveLength(1);
			})
	);

	it.effect(
		'when the leading tab closes, the next one leads and every tab attaches its views again',
		() =>
			Effect.gen(function* () {
				const b = yield* browser();
				const first = yield* b.tab();
				yield* first.observe(orders, Orders);
				yield* until(() => b.open() !== undefined);
				const shared = yield* (yield* b.tab()).observe(orders, Orders);
				const alone = yield* (yield* b.tab()).observe(north, Orders);
				yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* until(() => held(b.registered, 'c1').views.size === 2);
				const x = idOf(b.registered, orders.read),
					y = idOf(b.registered, north.read);
				yield* b.push({ t: 'answer', view: x, v: 1, value: page('o1') });
				yield* b.push({ t: 'answer', view: y, v: 1, value: page('n1') });
				yield* shows([shared], page('o1'));
				yield* shows([alone], page('n1'));
				yield* first.close;
				// the next tab in the lock's queue opens its own stream; its hello has every tab attach again
				yield* b.push({ t: 'hello', conn: 'c2', v: 1 });
				yield* until(() => held(b.registered, 'c2').views.size === 2);
				expect(held(b.registered, 'c2').views).toEqual(new Set([x, y]));
				expect(
					b.registered.filter((body) => body.conn === 'c2').flatMap((body) => body.add ?? [])
				).toHaveLength(2);
				yield* b.push({ t: 'answer', view: x, v: 2, value: page('o2') });
				yield* b.push({ t: 'answer', view: y, v: 2, value: page('n2') });
				yield* shows([shared], page('o2'));
				yield* shows([alone], page('n2'));
				expect(b.sources.filter((source) => !source.closed)).toHaveLength(1);
			})
	);

	it.effect('a closed tab lets go, without a poll, what it alone held once the grace passes', () =>
		Effect.gen(function* () {
			const b = yield* browser();
			const leader = yield* b.tab();
			yield* leader.observe(orders, Orders);
			yield* until(() => b.open() !== undefined);
			const follower = yield* b.tab();
			yield* follower.observe(orders, Orders);
			yield* follower.observe(north, Orders);
			yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
			yield* until(() => held(b.registered, 'c1').views.size === 2);
			const x = idOf(b.registered, orders.read);
			yield* follower.close;
			yield* graces(() => held(b.registered, 'c1').views.size === 1);
			expect(held(b.registered, 'c1').views).toEqual(new Set([x]));
		})
	);

	it.effect('a dropped link reconnects through the next tab in line, and both tabs follow it', () =>
		Effect.gen(function* () {
			const b = yield* browser();
			const first = yield* b.tab();
			const mine = yield* first.observe(orders, Orders);
			yield* until(() => b.open() !== undefined);
			const theirs = yield* (yield* b.tab()).observe(orders, Orders);
			yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
			yield* until(() => b.registered.length === 1);
			const view = idOf(b.registered, orders.read);
			yield* b.push({ t: 'answer', view, v: 1, value: page('o1') });
			yield* shows([mine, theirs], page('o1'));
			present(b.open()).onerror?.(new Event('error'));
			// the dropped tab lets the connection go; the tab waiting on its lock opens the next one
			yield* b.push({ t: 'hello', conn: 'c2', v: 1 });
			yield* until(() => held(b.registered, 'c2').views.size === 1);
			const again = b.registered.filter((body) => body.conn === 'c2');
			expect(again).toEqual([
				{
					conn: 'c2',
					drop: [],
					add: [{ view, read: orders.read, known: sha256_hex(JSON.stringify(page('o1'))) }]
				}
			]);
			// the dropped tab's retry follows the new leader and attaches without a registration
			yield* TestClock.adjust('30 seconds');
			yield* b.push({ t: 'same', view, v: 2, known: sha256_hex(JSON.stringify(page('o1'))) });
			yield* b.push({ t: 'delta', view, v: 3, ops: [upsert('o2')] });
			yield* shows([mine, theirs], page('o2', 'o1'));
			expect(b.registered.filter((body) => body.conn === 'c2')).toHaveLength(1);
			expect(b.sources.filter((source) => !source.closed)).toHaveLength(1);
		})
	);

	it.effect('every view and connection goes once its consumers leave and the grace passes', () =>
		Effect.gen(function* () {
			const b = yield* browser();
			const first = yield* b.tab();
			const keep = yield* first.observe(customers, Schema.Unknown);
			const mine = yield* first.observe(orders, Orders);
			yield* until(() => b.open() !== undefined);
			const second = yield* b.tab();
			const theirs = [yield* second.observe(orders, Orders), yield* second.observe(north, Orders)];
			yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
			yield* until(() => held(b.registered, 'c1').views.size === 3);
			for (const consumer of [mine, ...theirs]) yield* Fiber.interrupt(consumer.fiber);
			yield* graces(() => held(b.registered, 'c1').views.size === 1);
			expect(held(b.registered, 'c1').views).toEqual(new Set([idOf(b.registered, customers.read)]));
			yield* Fiber.interrupt(keep.fiber);
			yield* graces(() => b.sources.every((source) => source.closed));
		})
	);

	it.effect('the leading tab holds at most 500 views; one let go makes room', () =>
		Effect.gen(function* () {
			const b = yield* browser();
			yield* (yield* b.tab()).observe(orders, Orders);
			yield* until(() => b.open() !== undefined);
			const second = yield* b.tab();
			yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
			yield* until(() => b.registered.length === 1);
			const titled = (i: number): { readonly read: WireRead } => ({
				read: { m: 'query', a: [{ orders: { where: { title: { eq: `t${i}` } } } }] }
			});
			const reads = Array.from({ length: 500 }, (_, i) => titled(i));
			const views = yield* Effect.forEach(reads, (read) => second.observe(read, Orders));
			const refused = () => views.filter((view) => failure(view.fiber) !== undefined);
			yield* until(() => refused().length === 1 && held(b.registered, 'c1').views.size === 500);
			const [out] = refused();
			expect(failure(present(out).fiber)).toMatchObject({
				_tag: 'ReadFailed',
				code: 'too_many_subscriptions'
			});
			// churn: a consumer leaves; once the grace passes the leader drops its view, and the refused read fits
			yield* Fiber.interrupt(present(views.find((view) => view !== out)).fiber);
			yield* graces(() => held(b.registered, 'c1').views.size === 499);
			yield* second.observe(present(reads[views.findIndex((view) => view === out)]), Orders);
			yield* until(() => held(b.registered, 'c1').views.size === 500);
			expect(held(b.registered, 'c1').most).toBe(500);
		})
	);

	it.effect(
		'past 16 MiB of images held for other tabs the leader lets one go, and a joining tab registers it',
		() =>
			Effect.gen(function* () {
				const b = yield* browser();
				yield* (yield* b.tab()).observe(orders, Orders);
				yield* until(() => b.open() !== undefined);
				const theirs = yield* (yield* b.tab()).observe(north, Orders);
				yield* b.push({ t: 'hello', conn: 'c1', v: 0 });
				yield* until(() => held(b.registered, 'c1').views.size === 2);
				const view = idOf(b.registered, north.read);
				const big = {
					orders: { rows: [{ id: 'big', title: 'x'.repeat(16 * 1024 * 1024) }], next: null }
				};
				yield* b.push({ t: 'answer', view, v: 1, value: big });
				yield* until(() => theirs.current() !== undefined);
				const before = b.registered.length;
				const joined = yield* (yield* b.tab()).observe(north, Orders);
				yield* until(() => b.registered.length === before + 1);
				expect(b.registered.at(-1)).toEqual({
					conn: 'c1',
					drop: [],
					add: [{ view, read: north.read }]
				});
				yield* b.push({ t: 'answer', view, v: 2, value: page('n1') });
				yield* shows([theirs, joined], page('n1'));
			})
	);
});
