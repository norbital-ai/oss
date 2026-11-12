// The live engine (rules 64–66, §5.7): one lane per cell. A commit's RETURNING set is routed host-side: each view is
// judged in memory against the pre- and post-images, and a hit is sent as a patch built from the post-image (projected
// through the view's select and output, placed by its order), with no read. A delta that cannot be exact
// falls back as narrowly as it can — a PK `get` of the one row, else a re-read of the view — and is counted
// (`conservative=`, listed by `sweep()`). Commits coalesce per lane batch; each connection's fallbacks are one pipelined
// read. Budgets are typed errors on the view; the stream is untouched.
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Queue,
	Result,
	Scope,
	Stream
} from 'effect';
import { bindingsAt } from '../query/reader.ts';
import { Live, Manifest, Reads, type LiveView } from '../services.ts';
import type { Json } from '../../decl/values.ts';
import type { Frame, LiveErrorCode, PatchOp } from '../../protocol/wire.ts';
import type { Authority, Bindings, Captured } from '../contracts.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import { storedCaptures } from '../db/stored.ts';
import { ReadSnapshots, type ReadSnapshot } from '../query/snapshot.ts';
import { ViewCompiler, same, sourceKeys, type ViewPlan } from '../query/view.ts';
import * as patch from './patch.ts';

const MiB = 1024 * 1024;
/** §4.9's live row: per subscription / per connection / retained per cell. */
export const LIVE = {
	subscriptionBytes: 2 * MiB,
	perConnection: 500,
	connectionFrames: 1_000,
	connectionQueueBytes: 16 * MiB,
	cellBytes: 128 * MiB
} as const;

/** `value`: the view's current answer as the connection holds it (after every frame sent), `undefined` before the first. */
type View = LiveView & {
	id: string;
	plan: ViewPlan;
	snapshots: patch.Snapshots;
	readVersion: number;
	bytes: number;
	value: Json | undefined;
	arrivalsAfter: number | undefined;
	conservative?: true;
};
type Conn = {
	id: string;
	authority: Authority;
	send(frame: Frame): Effect.Effect<void>;
	end(discard: boolean): void;
	views: Map<string, View>;
	scope: Scope.Closeable;
};

type ReadAnswer = { ok: Json; snapshots: patch.Snapshots };
type Answer = ReadAnswer | { err: unknown };

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).byteLength;
export const LiveHubLive = Layer.effect(
	Live,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const reader = yield* Reads;
		const generation = yield* Scope.Scope;
		const bindings = Clock.currentTimeMillis.pipe(
			Effect.map((at) => bindingsAt(at, manifest.workspace.tz))
		);
		const catalog = catalog_of(manifest), compiler = new ViewCompiler(catalog, manifest);
		const lane = yield* Queue.unbounded<
			| { readonly _tag: 'Flush' }
			| { readonly _tag: 'Barrier'; readonly done: Deferred.Deferred<void> }
		>();
		const conns = new Map<string, Conn>();
		const byModel = new Map<string, Map<View, Conn>>();
		const index = (conn: Conn, view: View) => {
			for (const model of view.plan.models) {
				const views = byModel.get(model) ?? new Map<View, Conn>();
				views.set(view, conn);
				byModel.set(model, views);
			}
		};
		const unindex = (view: View) => {
			for (const model of view.plan.models) {
				const views = byModel.get(model);
				views?.delete(view);
				if (views?.size === 0) byModel.delete(model);
			}
		};
		// `v`: the last commit's sequence; `routed`: the last one whose views were answered (frames are stamped with it)
		let v = 0,
			routed = 0,
			retained = 0,
			conservative = 0,
			n = 0,
			reads = 0;
		let pending: { captured: Captured; version: number }[] = [],
			queued = false;
		const queue = () => {
			if (queued) return;
			queued = true;
			Queue.offerUnsafe(lane, { _tag: 'Flush' });
		};

		/** Sends a view's new value: its ops as a patch, or the whole answer; over a budget, the view errors alone. */
		const put = Effect.fn('Live.put')(function* (
			conn: Conn,
			view: View,
			answer: {
				value: Json;
				expected: number;
				ops?: readonly PatchOp[] | undefined;
				arrivals?: readonly Json[] | undefined;
				snapshots?: patch.Snapshots;
			}
		) {
			if (conn.views.get(view.id) !== view || view.readVersion !== answer.expected) return;
			const { value, ops, arrivals } = answer;
			const snapshots = ops === undefined ? answer.snapshots ?? new Map<string, ReadSnapshot>() : view.snapshots;
			const text = JSON.stringify(value);
			const unchanged =
				ops === undefined &&
				!arrivals?.length &&
				view.value !== undefined &&
				same(view.value, value);
			const bytes = bytesOf(text) + patch.keys(view.plan).reduce((sum, key) => sum + bytesOf(key), 0) +
				[...snapshots].reduce((sum, [key, snapshot]) => sum + bytesOf(key) + snapshot.bytes, 0);
			const over: [LiveErrorCode, string] | null =
				bytes > LIVE.subscriptionBytes
					? [
							'subscription_too_large',
							`the answer is ${bytes} bytes; a live view holds at most ${LIVE.subscriptionBytes}`
						]
					: retained - view.bytes + bytes > LIVE.cellBytes
						? ['cell_budget', `the cell retains at most ${LIVE.cellBytes} bytes of live answers`]
						: null;
			if (over !== null) {
				yield* drop(conn, view.id);
				yield* conn.send({ t: 'error', view: view.id, code: over[0], message: over[1] });
				return;
			}
			retained += bytes - view.bytes;
			view.bytes = bytes;
			view.value = value;
			view.snapshots = snapshots;
			view.readVersion++;
			if (unchanged) return;
			yield* conn.send(
				ops === undefined
					? {
							t: 'answer',
							view: view.id,
							v: routed,
							value,
							...(arrivals?.length ? { arrivals } : {})
						}
					: { t: 'patch', view: view.id, v: routed, ops, ...(arrivals?.length ? { arrivals } : {}) }
			);
		});
		const failed = (conn: Conn, view: View, err: unknown, expected: number) => Effect.suspend(() =>
			conn.views.get(view.id) !== view || view.readVersion !== expected ? Effect.void : conn.send({
				t: 'error',
				view: view.id,
				code: err instanceof BoltError ? err.code : 'internal',
				message: err instanceof Error ? err.message : String(err)
			}));

		/** One pipelined read; a failing batch is re-asked per read so one bad view errors alone. */
		const readAll = Effect.fn('Live.readAll')(function* (
			conn: Conn,
			batch: readonly ReadIR[],
			b: Bindings
		) {
			if (batch.length === 0) return [];
			reads += batch.length;
			const read = Effect.fn('Live.read')(function* (items: readonly ReadIR[]) {
				const snapshots = new Map<string, ReadSnapshot>();
				const values = yield* reader.run(items, { as: 'caller', authority: conn.authority }, b).pipe(
					Effect.provideService(ReadSnapshots, snapshots)
				);
				if (values.length !== items.length) return yield* Effect.fail(BoltError.make('internal', 'decode', 'The live read returned the wrong number of answers.'));
				const answers: ReadAnswer[] = [];
				for (const [index, item] of items.entries()) {
					const ok = values[index];
					if (ok === undefined) return yield* Effect.fail(BoltError.make('internal', 'decode', 'The live read returned no answer.'));
					const requested = new Set(sourceKeys(item));
					answers.push({ ok, snapshots: new Map([...snapshots].filter(([key]) => requested.has(key))) });
				}
				return answers;
			});
			return yield* read(batch).pipe(Effect.catch(() => Effect.forEach(batch, (item) =>
				read([item]).pipe(Effect.match({
					onSuccess: (values): Answer => values[0] ?? { err: BoltError.make('internal', 'decode', 'The live read returned no answer.') },
					onFailure: (err): Answer => ({ err })
				})), { concurrency: 'unbounded' })));

		});
		const answer = Effect.fn('Live.answer')(function* (
			conn: Conn,
			views: readonly View[],
			arrivals?: (view: View) => readonly Json[] | undefined
		) {
			const tickets = new Map(views.map((view) => [view, ++view.readVersion]));
			const b = yield* bindings;
			const values = yield* readAll(
				conn,
				views.map((view) => view.read),
				b
			);
			for (const [i, view] of views.entries()) {
				if (conn.views.get(view.id) !== view) continue;
				const expected = tickets.get(view);
				if (expected === undefined || view.readVersion !== expected) continue;
				const result = values[i];
				if (result === undefined) continue;
				if ('ok' in result) yield* put(conn, view, { value: result.ok, expected,
					snapshots: result.snapshots,
					...(arrivals === undefined ? {} : { arrivals: arrivals(view) }) });
				else yield* failed(conn, view, result.err, expected);
			}
		});
		const drop = (conn: Conn, id: string) =>
			Effect.sync(() => {
				const view = conn.views.get(id);
				if (view === undefined) return;
				unindex(view);
				retained -= view.bytes;
				conn.views.delete(id);
			});
		const disconnect = Effect.fn('Live.disconnect')(function* (id: string, discard = false) {
			const conn = conns.get(id);
			if (conn === undefined) return;
			for (const view of conn.views.values()) {
				unindex(view);
				retained -= view.bytes;
			}
			conn.views.clear();
			conns.delete(id);
			conn.end(discard);
			yield* Scope.close(conn.scope, Exit.void);
		});

		const flush = Effect.fn('Live.flush')(function* () {
			queued = false;
			routed = v;
			const batch = pending;
			pending = [];
			type Work = { view: View; captured: typeof batch };
			const interested = new Map<Conn, Map<View, Work>>();
			const work = (conn: Conn, view: View): Work => {
				const views = interested.get(conn) ?? new Map<View, Work>();
				interested.set(conn, views);
				const current: Work = views.get(view) ?? { view, captured: [] };
				views.set(view, current);
				return current;
			};
			for (const entry of batch)
				for (const [view, conn] of byModel.get(entry.captured.model) ?? [])
					work(conn, view).captured.push(entry);
			const arrivals = (view: View): readonly Json[] | undefined => {
				const after = view.arrivalsAfter;
				return after === undefined ? undefined : batch.flatMap(({ captured, version }) =>
					version > after ? patch.arrivals(view.plan, captured) : []);
			};
			const b = yield* bindings;
			let hit = 0, patched = 0;
			const fallback = new Set<View>();
			reads = 0;
			yield* Effect.forEach([...interested], ([conn, views]) => Effect.gen(function* () {
				const full: View[] = [], deltas: { view: View; rows: patch.Resolved[] }[] = [];
				for (const { view, captured } of views.values()) {
					if (conn.views.get(view.id) !== view) continue;
					const rows: patch.Resolved[] = [], value = view.value;
					let unsure = value === undefined;
					if (!unsure && value !== undefined)
						for (const { captured: c } of captured) {
							const result = Result.try(() => patch.resolve(view.plan, value, c, b, view.snapshots));
							if (Result.isFailure(result) || result.success === undefined) { unsure = true; break; }
							rows.push(...result.success);
						}
					if (!unsure && rows.length === 0) continue;
					hit++;
					if (unsure) full.push(view);
					else deltas.push({ view, rows });
				}
				// Whole answers and scoped single-row fetches still share one pipelined crossing.
				// one fetch per distinct row read: repeated captures of one row (coalesced commits) share it
				const gets = new Map<string, number>(), fetches: ReadIR[] = [];
				const slots = deltas.map(({ rows }) => rows.map((change) => {
					if (!('get' in change)) return null;
					const key = JSON.stringify(change.get.read);
					let slot = gets.get(key);
					if (slot === undefined) gets.set(key, slot = full.length + fetches.push(change.get.read) - 1);
					return slot;
				}));
				const tickets = new Map(full.map((view) => [view, ++view.readVersion]));
				const values = yield* readAll(conn, [...full.map((view) => view.read), ...fetches], b);
				for (const [i, view] of full.entries()) {
					const result = values[i], expected = tickets.get(view);
					if (result === undefined || expected === undefined || conn.views.get(view.id) !== view || view.readVersion !== expected) continue;
					if ('ok' in result) yield* put(conn, view, { value: result.ok, expected, snapshots: result.snapshots, arrivals: arrivals(view) });
					else yield* failed(conn, view, result.err, expected);
				}
				const again: View[] = [];
				for (const [d, { view, rows }] of deltas.entries()) {
					const got = (slots[d] ?? []).map((slot) => slot === null ? null : values[slot]);
					if (conn.views.get(view.id) !== view) continue;
					if (got.some((answer) => answer !== null)) fallback.add(view);
					if (view.value === undefined) { again.push(view); continue; }
					const work: patch.PatchWork = { value: view.value, ops: [], roots: new Set<string>() };
					const expected = view.readVersion;
					let exact = true;
					for (const [i, change] of rows.entries()) {
						const answer = got[i];
						if ('get' in change && (answer === undefined || answer === null || 'err' in answer)) { exact = false; break; }
						const result = Result.try(() => {
							const row = 'row' in change ? change.row : 'get' in change && answer !== null && answer !== undefined && 'ok' in answer
								? change.get.row(answer.ok) : undefined;
							return patch.apply(work, change, row, b, view.snapshots);
						});
						if (Result.isFailure(result) || !result.success) { exact = false; break; }
					}
					if (!exact) { again.push(view); continue; }
					const ops = patch.patches(work), incoming = arrivals(view);
					if (ops.length === 0 && !incoming?.length) continue;
					patched++;
					yield* put(conn, view, { value: work.value, expected, ops, arrivals: incoming });
				}
				for (const view of [...full, ...again]) fallback.add(view);
				yield* answer(conn, again, arrivals);
			}), { concurrency: 'unbounded', discard: true });
			// Every connection still sees the commit watermark, even when none of its views depends on it.
			yield* Effect.forEach([...conns.values()], (conn) => conn.send({ t: 'v', v: routed }), {
				concurrency: 'unbounded', discard: true
			});
			for (const view of fallback) view.conservative = true;
			conservative += fallback.size;
			yield* Effect.logDebug(
				`live v=${routed} rows=${batch.length} views=${hit} patched=${patched} conservative=${fallback.size} reads=${reads}`
			);
		});

		yield* Effect.gen(function* () {
			while (true) {
				const work = yield* Queue.take(lane);
				if (work._tag === 'Barrier') yield* Deferred.succeed(work.done, undefined);
				else
					yield* flush().pipe(
						Effect.catchDefect((defect) =>
							Effect.logError('Live routing failed. Clients will reconnect.', defect).pipe(
								Effect.andThen(
									Effect.forEach([...conns.keys()], (id) => disconnect(id, true), { discard: true })
								)
							)
						)
					);
			}
		}).pipe(Effect.forkScoped);
		yield* Effect.addFinalizer(() =>
			Effect.forEach([...conns.keys()], (id) => disconnect(id), { discard: true })
		);
		return Live.of({
			v: Effect.sync(() => v),
			connect: (authority) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const frames = yield* Queue.dropping<{ frame: Frame; bytes: number }, Cause.Done>(
							LIVE.connectionFrames
						);
						let queuedBytes = 0;
						const scope = yield* Scope.fork(generation);
						const id = `c${++n}`;
						const conn: Conn = {
							id,
							authority,
							views: new Map(),
							scope,
							send: (frame) =>
								Effect.suspend(() => {
									const bytes = bytesOf(JSON.stringify(frame));
									if (
										queuedBytes + bytes > LIVE.connectionQueueBytes ||
										!Queue.offerUnsafe(frames, { frame, bytes })
									)
										// A skipped patch would invalidate every later frame. Reconnect for a new snapshot.
										return disconnect(id, true);
									queuedBytes += bytes;
									return Effect.void;
								}),
							end: (discard) => {
								Queue.endUnsafe(frames);
								if (discard) Queue.shutdownUnsafe(frames);
							}
						};
						conns.set(id, conn);
						yield* conn.send({ t: 'hello', conn: id, v: routed });
						yield* Effect.addFinalizer(() => disconnect(id));
						return Stream.fromQueue(frames).pipe(
							Stream.map(({ frame, bytes }) => {
								queuedBytes -= bytes;
								return frame;
							})
						);
					})
				),
			authorityOf: (id) => Effect.sync(() => Option.fromNullishOr(conns.get(id)?.authority)),
			register: Effect.fn('Live.register')(function* (connId: string, id: string, view: LiveView) {
				const conn = conns.get(connId);
				if (conn === undefined)
					return yield* Effect.fail(
						BoltError.make('not_found', 'admission', 'the live connection is gone')
					);
				const plan = yield* compiler.compile(view.read, conn.authority);
				if (!conn.views.has(id) && conn.views.size >= LIVE.perConnection)
					return yield* Effect.fail(
						BoltError.make(
							'too_many_subscriptions',
							'admission',
							`a connection holds at most ${LIVE.perConnection} live views`
						)
					);
				yield* drop(conn, id);
				const state: View = {
					...view,
					id,
					plan,
					snapshots: new Map<string, ReadSnapshot>(),
					readVersion: 0,
					bytes: 0,
					value: undefined,
					arrivalsAfter: undefined
				};
				conn.views.set(id, state);
				index(conn, state);
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
				pending.push(...storedCaptures(catalog, captured).map((row) => ({ captured: row, version: v })));
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
				const views: View[] = [];
				for (const previous of [...conn.views.values()]) {
					const plan = yield* compiler.compile(previous.read, authority);
					unindex(previous);
					const view: View = { ...previous, value: undefined, snapshots: new Map<string, ReadSnapshot>(), plan };
					conn.views.set(view.id, view);
					index(conn, view);
					views.push(view);
				}
				yield* answer(conn, views);
			}),
			close: Effect.fn('Live.close')(function* (release: string) {
				for (const conn of [...conns.values()]) {
					yield* conn.send({ t: 'close', release });
					yield* disconnect(conn.id);
				}
			})
		});
	})
);
