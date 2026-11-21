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
	Schema,
	Scope,
	Stream
} from 'effect';
import { actor_ref } from '../access/actor.ts';
import { bindingsAt } from '../query/reader.ts';
import { Live, Manifest, Reads, type LiveView } from '../services.ts';
import type { Json } from '../../decl/values.ts';
import { canonical, sha256_hex } from '@norbital-ai/store/hash';
import type { Frame, LiveErrorCode, PatchOp } from '../../protocol/wire.ts';
import { PatchOps } from '../../protocol/schema.ts';
import type { Authority, Bindings, Captured } from '../contracts.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import { storedCaptures } from '../db/stored.ts';
import { ReadSnapshots, type ReadSnapshot } from '../query/snapshot.ts';
import { ViewCompiler, same, sourceKeys, type ViewPlan } from '../query/view.ts';
import * as patch from './patch.ts';

const MiB = 1024 * 1024;
const PRINCIPAL = ['email', 'phone', 'kind', 'active', 'admin', 'team', 'party', 'signup'] as const;
export const LIVE = {
	subscriptionBytes: 2 * MiB,
	perConnection: 500,
	connectionFrames: 1_000,
	connectionQueueBytes: 16 * MiB,
	cellBytes: 128 * MiB,
	maxConnections: 500
} as const;

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
type SharedAnswer = Answer | { readonly retry: true };
type SharedMap = Map<string, Deferred.Deferred<SharedAnswer>>;

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).byteLength;
const carried = Schema.is(PatchOps);
const readKey = (authority: Authority, item: ReadIR) => `${authority.key}\u0000${canonical(item)}`;
export const LiveHubLive = Layer.effect(
	Live,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const reader = yield* Reads;
		const generation = yield* Scope.Scope;
		const bindings = Clock.currentTimeMillis.pipe(
			Effect.map((at) => bindingsAt(at, manifest.workspace.tz))
		);
		const catalog = catalog_of(manifest),
			compiler = new ViewCompiler(catalog, manifest);
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
		let v = 0,
			routed = 0,
			retained = 0,
			conservative = 0,
			n = 0,
			reads = 0;
		let pending: { captured: Captured; version: number }[] = [],
			queued = false;
		const inflight: SharedMap = new Map();
		const queue = () => {
			if (queued) return;
			queued = true;
			Queue.offerUnsafe(lane, { _tag: 'Flush' });
		};

		const put = Effect.fn('Live.put')(function* (
			conn: Conn,
			view: View,
			answer: {
				value: Json;
				expected: number;
				delta?: { readonly ops: readonly PatchOp[]; readonly bytes: number } | undefined;
				arrivals?: readonly Json[] | undefined;
				snapshots?: patch.Snapshots;
			}
		) {
			if (conn.views.get(view.id) !== view || view.readVersion !== answer.expected) return;
			const { value, delta, arrivals } = answer;
			const snapshots =
				delta === undefined
					? (answer.snapshots ?? new Map<string, ReadSnapshot>())
					: view.snapshots;
			const text = delta === undefined ? JSON.stringify(value) : null;
			const reusable =
				text !== null &&
				view.value === undefined &&
				!arrivals?.length &&
				view.known !== undefined &&
				view.known === sha256_hex(text);
			const unchanged =
				delta === undefined &&
				!arrivals?.length &&
				view.value !== undefined &&
				same(view.value, value);
			const bytes =
				text === null
					? view.bytes + (delta?.bytes ?? 0)
					: bytesOf(text) +
						patch.keys(view.plan).reduce((sum, key) => sum + bytesOf(key), 0) +
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
			if (reusable && view.known !== undefined) {
				yield* conn.send({ t: 'same', view: view.id, v: routed, known: view.known });
				return;
			}
			yield* conn.send(
				delta === undefined
					? {
							t: 'answer',
							view: view.id,
							v: routed,
							value,
							...(arrivals?.length ? { arrivals } : {})
						}
					: {
							t: 'delta',
							view: view.id,
							v: routed,
							ops: delta.ops,
							...(arrivals?.length ? { arrivals } : {})
						}
			);
		});
		const failed = (conn: Conn, view: View, err: unknown, expected: number) =>
			Effect.suspend(() =>
				conn.views.get(view.id) !== view || view.readVersion !== expected
					? Effect.void
					: drop(conn, view.id).pipe(
							Effect.andThen(
								conn.send({
									t: 'error',
									view: view.id,
									code: err instanceof BoltError ? err.code : 'internal',
									message: err instanceof Error ? err.message : String(err)
								})
							)
						)
			);

		const readAll = Effect.fn('Live.readAll')(function* (
			conn: Conn,
			batch: readonly ReadIR[],
			b: Bindings,
			shared?: SharedMap,
			prefix?: string
		): Effect.fn.Return<readonly Answer[]> {
			if (batch.length === 0) return [];
			const own: ReadIR[] = [],
				mine: { readonly key: string; readonly made: Deferred.Deferred<SharedAnswer> }[] = [];
			const slots = batch.map((item) => {
				if (shared === undefined) return undefined;
				const key = `${prefix ?? ''}${readKey(conn.authority, item)}`;
				const held = shared.get(key);
				if (held !== undefined) return held;
				const made = Deferred.makeUnsafe<SharedAnswer>();
				shared.set(key, made);
				own.push(item);
				mine.push({ key, made });
				return made;
			});
			if (shared === undefined) own.push(...batch);
			reads += own.length;
			const read = Effect.fn('Live.read')(function* (items: readonly ReadIR[]) {
				const snapshots = new Map<string, ReadSnapshot>();
				const values = yield* reader
					.run(items, { as: 'caller', authority: conn.authority }, b)
					.pipe(Effect.provideService(ReadSnapshots, snapshots));
				if (values.length !== items.length)
					return yield* Effect.fail(
						BoltError.make(
							'internal',
							'decode',
							'The live read returned the wrong number of answers.'
						)
					);
				const answers: ReadAnswer[] = [];
				for (const [index, item] of items.entries()) {
					const ok = values[index];
					if (ok === undefined)
						return yield* Effect.fail(
							BoltError.make('internal', 'decode', 'The live read returned no answer.')
						);
					const requested = new Set(sourceKeys(item));
					answers.push({
						ok,
						snapshots: new Map([...snapshots].filter(([key]) => requested.has(key)))
					});
				}
				return answers;
			});
			const answers = read(own).pipe(
				Effect.catch(() =>
					Effect.forEach(
						own,
						(item) =>
							read([item]).pipe(
								Effect.match({
									onSuccess: (values): Answer =>
										values[0] ?? {
											err: BoltError.make('internal', 'decode', 'The live read returned no answer.')
										},
									onFailure: (err): Answer => ({ err })
								})
							),
						{ concurrency: 'unbounded' }
					)
				)
			);
			if (shared === undefined) return yield* answers;
			yield* (own.length === 0 ? Effect.succeed([]) : answers).pipe(
				Effect.onExit((exit) => {
					if (prefix !== undefined)
						for (const { key, made } of mine) if (shared.get(key) === made) shared.delete(key);
					const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
					const fallback: SharedAnswer = interrupted
						? { retry: true }
						: {
								err: BoltError.make('internal', 'decode', 'The live read returned no answer.')
							};
					return Effect.forEach(
						mine,
						({ made }, index) =>
							Deferred.succeed(made, (Exit.isSuccess(exit) ? exit.value[index] : undefined) ?? fallback),
						{ discard: true }
					);
				})
			);
			const resolved = yield* Effect.forEach(slots, (slot) =>
				slot === undefined
					? Effect.succeed<SharedAnswer>({
							err: BoltError.make('internal', 'decode', 'The live read returned no answer.')
						})
					: Deferred.await(slot)
			);
			const retryAt: number[] = [];
			const retryItems: ReadIR[] = [];
			const out: Answer[] = [];
			for (const [index, entry] of resolved.entries()) {
				if ('retry' in entry) {
					const item = batch[index];
					if (item !== undefined) {
						retryAt.push(index);
						retryItems.push(item);
					}
					out.push({
						err: BoltError.make('internal', 'decode', 'The live read returned no answer.')
					});
				} else {
					out.push(entry);
				}
			}
			if (retryItems.length > 0) {
				const retried = yield* readAll(conn, retryItems, b);
				for (const [i, target] of retryAt.entries()) {
					const entry = retried[i];
					if (entry !== undefined) out[target] = entry;
				}
			}
			return out;
		});
		const answer = Effect.fn('Live.answer')(function* (
			conn: Conn,
			views: readonly View[],
			arrivals?: (view: View) => readonly Json[] | undefined,
			shared?: SharedMap,
			b?: Bindings,
			prefix?: string
		) {
			if (views.length === 0) return;
			const tickets = new Map(views.map((view) => [view, ++view.readVersion]));
			const resolved = b ?? (yield* bindings);
			const values = yield* readAll(
				conn,
				views.map((view) => view.read),
				resolved,
				shared,
				prefix
			);
			for (const [i, view] of views.entries()) {
				if (conn.views.get(view.id) !== view) continue;
				const expected = tickets.get(view);
				if (expected === undefined || view.readVersion !== expected) continue;
				const result = values[i];
				if (result === undefined) continue;
				if ('ok' in result)
					yield* put(conn, view, {
						value: result.ok,
						expected,
						snapshots: result.snapshots,
						...(arrivals === undefined ? {} : { arrivals: arrivals(view) })
					});
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
			const b = yield* bindings;
			const memberships = manifest.workspace.memberships;
			const roleChange =
				memberships?.bundles !== undefined &&
				batch.some(({ captured }) => captured.model === memberships.bundles?.levels);
			const changed = new Set(
				batch.flatMap(({ captured: c }) =>
					memberships !== undefined && (c.model === memberships.model || c.model === memberships.bundles?.assignments)
						? [c.old?.['member'], c.new?.['member']].filter((id): id is string => typeof id === 'string').map(id => 'member:' + id)
						: c.model === 'sys_session' && c.op === 'delete' && typeof c.old?.['user'] === 'string'
						? [`member:${c.old['user']}`]
						: c.model === 'sys_user' &&
							  PRINCIPAL.some(
									(field) => JSON.stringify(c.old?.[field]) !== JSON.stringify(c.new?.[field])
							  )
							? [`member:${c.id}`]
							: c.model === 'sys_api_key' && c.old?.['revision'] !== c.new?.['revision']
								? [`api_key:${c.id}`]
								: []
				)
			);
			for (const conn of [...conns.values()]) {
				const day = conn.authority.membershipDay;
				if (changed.has(actor_ref(conn.authority.actor)) || (day !== undefined && (roleChange || day !== b.today)))
					yield* disconnect(conn.id);
			}
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
				return after === undefined
					? undefined
					: batch.flatMap(({ captured, version }) =>
							version > after ? patch.arrivals(view.plan, captured) : []
						);
			};
			let hit = 0,
				patched = 0;
			const fallback = new Set<View>();
			reads = 0;
			const shared: SharedMap = new Map();
			yield* Effect.forEach(
				[...interested],
				([conn, views]) =>
					Effect.gen(function* () {
						const full: View[] = [],
							deltas: { view: View; rows: patch.Resolved[] }[] = [];
						for (const { view, captured } of views.values()) {
							if (conn.views.get(view.id) !== view) continue;
							const rows: patch.Resolved[] = [],
								value = view.value;
							let unsure = value === undefined;
							if (!unsure && value !== undefined)
								for (const { captured: c } of captured) {
									const result = Result.try(() =>
										patch.resolve(view.plan, value, c, b, view.snapshots)
									);
									if (Result.isFailure(result) || result.success === undefined) {
										unsure = true;
										break;
									}
									rows.push(...result.success);
								}
							if (!unsure && rows.length === 0) continue;
							hit++;
							if (unsure) full.push(view);
							else deltas.push({ view, rows });
						}
						const gets = new Map<string, number>(),
							fetches: ReadIR[] = [];
						const slots = deltas.map(({ rows }) =>
							rows.map((change) => {
								if (!('get' in change)) return null;
								const key = canonical(change.get.read);
								let slot = gets.get(key);
								if (slot === undefined)
									gets.set(key, (slot = full.length + fetches.push(change.get.read) - 1));
								return slot;
							})
						);
						const tickets = new Map(full.map((view) => [view, ++view.readVersion]));
						const values = yield* readAll(
							conn,
							[...full.map((view) => view.read), ...fetches],
							b,
							shared
						);
						for (const [i, view] of full.entries()) {
							const result = values[i],
								expected = tickets.get(view);
							if (
								result === undefined ||
								expected === undefined ||
								conn.views.get(view.id) !== view ||
								view.readVersion !== expected
							)
								continue;
							if ('ok' in result)
								yield* put(conn, view, {
									value: result.ok,
									expected,
									snapshots: result.snapshots,
									arrivals: arrivals(view)
								});
							else yield* failed(conn, view, result.err, expected);
						}
						const again: View[] = [];
						for (const [d, { view, rows }] of deltas.entries()) {
							const got = (slots[d] ?? []).map((slot) => (slot === null ? null : values[slot]));
							if (conn.views.get(view.id) !== view) continue;
							if (got.some((answer) => answer !== null)) fallback.add(view);
							if (view.value === undefined) {
								again.push(view);
								continue;
							}
							const work: patch.PatchWork = { value: view.value, ops: [], bytes: 0 };
							const expected = view.readVersion;
							let exact = true;
							for (const [i, change] of rows.entries()) {
								const answer = got[i];
								if (
									'get' in change &&
									(answer === undefined || answer === null || 'err' in answer)
								) {
									exact = false;
									break;
								}
								const result = Result.try(() => {
									const row =
										'row' in change
											? change.row
											: 'get' in change && answer !== null && answer !== undefined && 'ok' in answer
												? change.get.row(answer.ok)
												: undefined;
									return patch.apply(work, change, row, b, view.snapshots);
								});
								if (Result.isFailure(result) || !result.success) {
									exact = false;
									break;
								}
							}
							if (!exact) {
								again.push(view);
								continue;
							}
							const { value, ops, bytes } = work,
								incoming = arrivals(view);
							const effectiveOps = ops.length > 0 && same(view.value, value) ? [] : ops;
							if (effectiveOps.length === 0 && !incoming?.length) continue;
							patched++;
							yield* put(
								conn,
								view,
								carried(effectiveOps)
									? {
											value: effectiveOps.length === 0 ? view.value : value,
											expected,
											delta: { ops: effectiveOps, bytes: effectiveOps.length === 0 ? 0 : bytes },
											arrivals: incoming
										}
									: { value, expected, snapshots: view.snapshots, arrivals: incoming }
							);
						}
						for (const view of [...full, ...again]) fallback.add(view);
						yield* answer(conn, again, arrivals, shared, b);
					}),
				{ concurrency: 'unbounded', discard: true }
			);
			yield* Effect.forEach([...conns.values()], (conn) => conn.send({ t: 'v', v: routed }), {
				concurrency: 'unbounded',
				discard: true
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
										// A skipped delta would invalidate every later one. Reconnect for a new snapshot.
										return disconnect(id, true);
									queuedBytes += bytes;
									return Effect.void;
								}),
							end: (discard) => {
								Queue.endUnsafe(frames);
								if (discard) Queue.shutdownUnsafe(frames);
							}
						};
						if (conns.size >= LIVE.maxConnections) {
							const oldest = conns.keys().next().value;
							if (oldest !== undefined) yield* disconnect(oldest, true);
						}
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
				if (conn.authority.membershipDay !== undefined && conn.authority.membershipDay !== (yield* bindings).today) {
					yield* disconnect(connId, true);
					return yield* Effect.fail(BoltError.make('not_found', 'admission', 'the live connection is gone'));
				}
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
				const at = v;
				const b = yield* bindings;
				yield* answer(conn, [state], undefined, inflight, b, `${at}\u0000${b.now}\u0000`);
				state.arrivalsAfter = v;
			}),
			drop: (connId, id) => {
				const conn = conns.get(connId);
				return conn === undefined ? Effect.void : drop(conn, id);
			},

			publish(captured: readonly Captured[]): number {
				if (captured.length === 0) return v;
				v++;
				inflight.clear();
				pending.push(
					...storedCaptures(catalog, captured).map((row) => ({ captured: row, version: v }))
				);
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
					const view: View = {
						...previous,
						value: undefined,
						snapshots: new Map<string, ReadSnapshot>(),
						plan
					};
					conn.views.set(view.id, view);
					index(conn, view);
					views.push(view);
				}
				yield* answer(conn, views, undefined, new Map());
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
