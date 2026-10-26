// The scoped browser client: reads and operations are Effects; current reads are Streams.
import {
	Clock,
	Deferred,
	type Duration,
	Effect,
	FiberMap,
	Option,
	Queue,
	Schedule,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import type { HttpClient } from 'effect/unstable/http';
import type { FileRef, Json } from '../decl/values.ts';
import { Instant, PlainDate } from '@norbital-ai/std/date';
import { reactiveClock, reactiveQuery } from '@norbital-ai/ui/effect';
import type { FileUrlOptions } from '@norbital-ai/std/kind';
import {
	ActConflict,
	ActRefused,
	ActUnknown,
	DescribeTimeout,
	ProtocolFailed,
	ReadFailed,
	Refusal,
	TransportFailed,
	Unavailable
} from '../decl/errors.ts';
import type { ActOutcome } from '../engine/contracts.ts';
import {
	RecordCapabilitiesSchema,
	RestorePreviewSchema,
	type RecordParentContext
} from '../protocol/record-contracts.ts';
import type { ApprovalView } from '../engine/approvals/approvals.ts';
import {
	HEADERS,
	PATHS,
	refusalOfStatus,
	uuidv7,
	type Frame,
	type LiveBody,
	type PatchOp,
	type WireRead
} from '../protocol/wire.ts';
import { ActReply, LiveReply, QReply, WireError } from '../protocol/schema.ts';
import { liveStream, pageSignals, type EventSourceLike, type Signals } from './stream.ts';
import { browserCatalog, type BrowserCatalog } from '../protocol/catalog.ts';
import { decodeView, type Catalog } from '@norbital-ai/store';
import { storeSync } from '../protocol/errors.ts';
import type { Query } from './page-bolt.ts';
import type { ConvertRequest, ConvertSource } from '../decl/runtime/facilities.ts';
import { browserTransport } from '../protocol/client.ts';
import { FileRefSchema, storedFileUrl } from './file-ref.ts';
import { encodeWire, reviveWire, type Wired } from '@norbital-ai/std/wire';

export type BoltConfig = {
	actor: Json;
	locale: string;
	tz?: string;
	messages?: Readonly<Record<string, string>>;
	base?: string;
	fetch?: typeof fetch;
	httpClient?: HttpClient.HttpClient;
	openStream?: (url: string) => EventSourceLike;
	/** Current reads are read again on this interval instead of streamed: an engine whose responses never stream. */
	poll?: Duration.Input;
	signals?: Signals;
	uuid?: () => string;
	now?: () => string;
	catalog?: BrowserCatalog;
	describe?: boolean;
	contract?: string;
	onNotice?: (notice: Row) => void;
};
type Row = { readonly [field: string]: Json };
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
type Paint = { collection: string; apply(value: Json, read: WireRead): Json };
type ViewState = { value: Json | undefined; error: ReadFailed | undefined; sequence: number };
type ViewConsumer = {
	readonly fiberId: number;
	readonly delivered: SubscriptionRef.SubscriptionRef<number>;
};
type View = {
	id: string;
	key: string;
	read: WireRead;
	server: Json | undefined;
	v: number;
	consumers: Set<ViewConsumer>;
	registered: boolean;
	state: SubscriptionRef.SubscriptionRef<ViewState>;
};
const typed = (v: Json): Json =>
	reviveWire(
		'',
		jsonArray(v)
			? v.map(typed)
			: isRow(v)
				? Object.fromEntries(
						Object.entries(v).map(([key, item]): [string, Json] => [key, typed(item)])
					)
				: v
	) as Json;
const CapabilitiesAnswer = Schema.Struct({ value: RecordCapabilitiesSchema });
const FileAnswer = FileRefSchema;
const FilterStep = Schema.Union([
	Schema.Struct({ k: Schema.Literal('field'), name: Schema.String }),
	Schema.Struct({ k: Schema.Literal('is'), rel: Schema.String }),
	Schema.Struct({ k: Schema.Literal('arm'), rel: Schema.String, arm: Schema.String }),
	Schema.Struct({ k: Schema.Literals(['some', 'every', 'none']), rel: Schema.String }),
	Schema.Struct({ k: Schema.Literal('count'), rel: Schema.String }),
	Schema.Struct({
		k: Schema.Literal('agg'),
		rel: Schema.String,
		fn: Schema.Literals(['sum', 'avg', 'min', 'max']),
		of: Schema.String
	})
]);
const FilterArg = Schema.Union([
	Schema.Struct({ lit: Schema.Json }),
	Schema.Struct({ list: Schema.Array(Schema.Json) }),
	Schema.Struct({
		range: Schema.Tuple([Schema.Json, Schema.Json]),
		label: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({ actor: Schema.Literals(['id', 'party', 'teams']) })
]);
const FilterOptionsAnswer = Schema.Struct({
	fields: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			path: Schema.Array(FilterStep),
			op: Schema.String,
			opLabel: Schema.String,
			kind: Schema.String,
			values: Schema.optionalKey(
				Schema.Array(Schema.Struct({ label: Schema.String, arg: FilterArg }))
			),
			sort: Schema.optionalKey(Schema.String)
		})
	)
});
const errorOf = Schema.decodeUnknownOption(WireError);
const decode = <A>(schema: Schema.Codec<A, unknown>, body: unknown) =>
	Schema.decodeUnknownEffect(schema)(body).pipe(
		Effect.mapError(() => new ProtocolFailed({ message: 'The host returned an invalid answer.' }))
	);
/** A held write and one past the person-wait (`running`, followed through `runs`) are answers; the rest fail. */
function settled(
	outcome: ActOutcome
): Effect.Effect<
	Extract<ActOutcome, { kind: 'committed' | 'pendingApproval' | 'running' }>,
	ActRefused | ActConflict | ActUnknown
> {
	switch (outcome.kind) {
		case 'committed':
		case 'pendingApproval':
		case 'running':
			return Effect.succeed(outcome);
		case 'refused':
			return Effect.fail(new ActRefused(outcome));
		case 'conflict':
			return Effect.fail(new ActConflict({ records: outcome.records }));
		case 'unknown':
			return Effect.fail(new ActUnknown({ invocation: outcome.invocation }));
	}
}
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (value: Json): readonly Json[] => (jsonArray(value) ? value : [value]);
const RELATION_OPS = ['create', 'update', 'delete', 'upsert', 'link', 'unlink'];
const PAINTED = new Set(['create', 'update', 'delete']);

/** Rule 65: a patch applied to a view's value (a page's `rows`, or a `get`'s row); `undefined` when it does not fit it. */
export function patched(value: Json | undefined, ops: readonly PatchOp[]): Json | undefined {
	if (value === undefined) return undefined;
	const pageRows = isRow(value) ? value['rows'] : undefined;
	let page = isRow(value) && jsonArray(pageRows) ? value : null;
	let rows: Json[] = jsonArray(pageRows) ? [...pageRows] : value === null ? [] : [value];
	for (const o of ops) {
		if (o.op === 'meta') {
			if (page === null) return undefined;
			page = { ...page, [o.key]: o.value };
			continue;
		}
		rows = rows.filter(
			(r) => !isRow(r) || r['id'] !== (o.op === 'remove' ? o.id : isRow(o.row) ? o.row['id'] : null)
		);
		if (o.op === 'upsert') {
			if (o.index > rows.length) return undefined;
			rows.splice(o.index, 0, o.row);
		}
	}
	if (page !== null) return { ...page, rows };
	return rows.length > 1 ? undefined : (rows[0] ?? null);
}

/** The paint of one generated write over the live reads of its collection (rule 67); queries do not paint. */
function paintOf(collection: string, verb: string, input: Json, key: string): Paint {
	const rows = (v: Json, read: WireRead, each: (rows: readonly Row[]) => readonly Row[]): Json => {
		if (read.m !== 'query') return v;
		const values = isRow(v) ? v['rows'] : undefined;
		if (isRow(v) && jsonArray(values))
			return values.every(isRow) ? { ...v, rows: each(values) } : v;
		return isRow(read.a[1]) && read.a[1]['id'] !== undefined && isRow(v)
			? (each([v])[0] ?? null)
			: v;
	};
	if (verb === 'create') {
		const created = list(input).map((x, i): Row => ({
			id: `pending:${key}:${i}`,
			...(isRow(x) ? x : {})
		}));
		return {
			collection,
			apply: (v, read) =>
				isRow(v) && jsonArray(v['rows']) ? rows(v, read, (rs) => [...created, ...rs]) : v
		};
	}
	if (verb === 'delete') {
		const gone = new Set(list((isRow(input) ? input['target'] : null) as Json).map(String));
		return {
			collection,
			apply: (v, m) => rows(v, m, (rs) => rs.filter((r) => !gone.has(String(r['id']))))
		};
	}
	const sets = new Map<string, Row>();
	for (const x of list(input))
		if (isRow(x) && isRow(x['set'])) {
			// a nested relation op is painted by its own rows' views, never merged as a field
			const set = Object.fromEntries(
				Object.entries(x['set']).filter(
					([, v]) => !(isRow(v) && Object.keys(v).some((k) => RELATION_OPS.includes(k)))
				)
			);
			for (const id of list(x['target'] as Json)) sets.set(String(id), set);
		}
	return {
		collection,
		apply: (v, m) =>
			rows(v, m, (rs) =>
				rs.map((r) => (sets.has(String(r['id'])) ? { ...r, ...sets.get(String(r['id'])) } : r))
			)
	};
}

export const createBolt = (config: BoltConfig) =>
	Effect.gen(function* () {
		const base = config.base ?? '';
		const transport = browserTransport(config);
		const uuid = config.uuid ?? uuidv7;
		const views = new Map<string, View>();
		const paints = new Set<Paint>();
		const revisions = new Map<string, number>();
		const waiters = new Map<Deferred.Deferred<void>, number>();
		const grace = yield* FiberMap.make<string, void, never>();
		const reconnects = yield* Queue.sliding<void>(1);
		const status = yield* SubscriptionRef.make<SyncStatus>('idle');
		let conn: string | null = null,
			applied = 0,
			n = 0,
			generation = 0;
		let closed: string | null = null,
			decoder: Catalog | undefined;
		let noticeVersion = -1;
		const noticeIds = new Set<string>();
		const track = (value: Json | undefined) => {
			for (const row of jsonArray(value)
				? value
				: isRow(value) && jsonArray(value['rows'])
					? value['rows']
					: [value ?? null])
				if (isRow(row) && typeof row['id'] === 'string' && typeof row['revision'] === 'number')
					revisions.set(row['id'], row['revision']);
		};
		const shown = (view: View) => {
			let value = view.server;
			if (value !== undefined)
				for (const paint of paints)
					if (paint.collection === view.read.a[0]) value = paint.apply(value, view.read);
			return value;
		};
		const notify = (view: View, error?: ReadFailed) =>
			SubscriptionRef.modify(view.state, (state) => {
				const sequence = state.sequence + 1;
				return [sequence, { value: shown(view), error, sequence }] as const;
			});
		const delivered = (view: View, sequence: number, initiatingFiber?: number) =>
			Effect.forEach(
				[...view.consumers].filter((consumer) => consumer.fiberId !== initiatingFiber),
				(consumer) =>
					SubscriptionRef.changes(consumer.delivered).pipe(
						Stream.filter((seen) => seen >= sequence),
						Stream.take(1),
						Stream.runDrain
					),
				{ concurrency: 'unbounded', discard: true }
			);
		const repaint = (collection: string, initiatingFiber: number) =>
			Effect.gen(function* () {
				const changed = yield* Effect.forEach(
					[...views.values()].filter((view) => view.read.a[0] === collection),
					(view) => notify(view).pipe(Effect.map((sequence) => ({ view, sequence })))
				);
				yield* Effect.forEach(
					changed,
					({ view, sequence }) => delivered(view, sequence, initiatingFiber),
					{
						concurrency: 'unbounded',
						discard: true
					}
				);
			});

		const visible = (initiatingFiber?: number) =>
			Effect.suspend(() =>
				Effect.forEach(
					[...views.values()],
					(view) =>
						SubscriptionRef.get(view.state).pipe(
							Effect.flatMap((state) => delivered(view, state.sequence, initiatingFiber))
						),
					{ concurrency: 'unbounded', discard: true }
				)
			);

		const advance = (version: number) =>
			Effect.gen(function* () {
				applied = Math.max(applied, version);
				for (const [waiter, target] of waiters)
					if (applied >= target) yield* Deferred.succeed(waiter, undefined);
			});
		const register = (add: readonly View[], drop: readonly string[] = []) =>
			Effect.gen(function* () {
				if (conn === null || (add.length === 0 && drop.length === 0)) return;
				const registeredGeneration = generation;
				for (const view of add) view.registered = true;
				const body: LiveBody = {
					conn,
					drop,
					add: add.map((view) => ({
						view: view.id,
						read: view.read
					}))
				};
				const response = yield* transport.request('POST', PATHS.live, body).pipe(Effect.result);
				if (generation !== registeredGeneration) return;
				if (response._tag === 'Failure') {
					for (const view of add) view.registered = false;
					return;
				}
				const refusal = errorOf(response.success.body);
				const errors = Option.isSome(refusal)
					? add.map((view) => ({ view: view.id, ...refusal.value.error }))
					: (yield* decode(LiveReply, response.success.body)).errors;
				if (
					errors.some(
						(error) => error.code === 'notFound' && error.message === 'the live connection is gone'
					)
				) {
					generation++;
					conn = null;
					for (const view of views.values()) view.registered = false;
					yield* Queue.offer(reconnects, undefined);
					return;
				}
				for (const error of errors) {
					const view = views.get(error.view);
					if (view !== undefined)
						yield* notify(view, new ReadFailed({ code: error.code, message: error.message }));
				}
			}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		const onFrame = (frame: Frame) =>
			Effect.gen(function* () {
				const view = 'view' in frame ? views.get(frame.view) : undefined;
				switch (frame.t) {
					case 'hello':
						generation++;
						noticeVersion = frame.v;
						noticeIds.clear();
						conn = frame.conn;
						applied = frame.v;
						yield* SubscriptionRef.set(status, 'live');
						for (const item of views.values()) {
							item.registered = false;
							item.v = -1;
						}
						yield* register([...views.values()]).pipe(Effect.forkScoped);
						return;
					case 'answer':
						if (
							view !== undefined &&
							view.read.m === 'inbox' &&
							frame.v > view.v &&
							frame.v >= noticeVersion
						) {
							if (frame.v > noticeVersion) {
								noticeVersion = frame.v;
								noticeIds.clear();
							}
							for (const notice of frame.arrivals ?? [])
								if (
									isRow(notice) &&
									typeof notice['id'] === 'string' &&
									!noticeIds.has(notice['id'])
								) {
									noticeIds.add(notice['id']);
									config.onNotice?.(typed(notice) as Row);
								}
						}
						if (view !== undefined) {
							view.server = typed(frame.value);
							view.v = frame.v;
							track(view.server);
							yield* notify(view);
						}
						return yield* advance(frame.v);
					case 'patch': {
						if (view === undefined || frame.v <= view.v) return yield* advance(frame.v);
						const next = patched(
							view.server,
							frame.ops.map((op) => (op.op === 'upsert' ? { ...op, row: typed(op.row) } : op))
						);
						if (next === undefined) {
							view.registered = false;
							return yield* register([view]);
						}
						view.server = next;
						view.v = frame.v;
						for (const op of frame.ops) if (op.op === 'upsert') track(op.row);
						yield* notify(view);
						return yield* advance(frame.v);
					}
					case 'error':
						if (view !== undefined) {
							view.registered = false;
							yield* notify(view, new ReadFailed({ code: frame.code, message: frame.message }));
						}
						return;
					case 'v':
						return yield* advance(frame.v);
					case 'close':
						closed = frame.release;
						yield* SubscriptionRef.set(status, 'closed');
						return;
				}
			});
		const frames = yield* liveStream(
			() =>
				config.openStream?.(`${base}${PATHS.live}`) ??
				new EventSource(`${base}${PATHS.live}`, { withCredentials: true }),
			Effect.gen(function* () {
				conn = null;
				generation++;
				for (const view of views.values()) view.registered = false;
				for (const waiter of waiters.keys()) yield* Deferred.succeed(waiter, undefined);
				yield* SubscriptionRef.set(
					status,
					closed !== null ? 'closed' : views.size === 0 ? 'idle' : 'connecting'
				);
			}),
			config.signals ?? pageSignals(),
			Queue.take(reconnects)
		).pipe(
			Stream.tap(onFrame),
			Stream.takeUntil((frame) => frame.t === 'close'),
			Stream.share({ capacity: 'unbounded', idleTimeToLive: '30 seconds' })
		);
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				for (const view of views.values())
					for (const consumer of view.consumers)
						yield* SubscriptionRef.set(consumer.delivered, Infinity);
				views.clear();
				for (const waiter of waiters.keys()) yield* Deferred.succeed(waiter, undefined);
				yield* SubscriptionRef.set(status, 'idle');
			})
		);
		const caughtUp = (version: number, initiatingFiber?: number) =>
			Effect.gen(function* () {
				if (conn === null) return;
				if (applied >= version) return yield* visible(initiatingFiber);
				const waiter = yield* Deferred.make<void>();
				waiters.set(waiter, version);
				yield* Deferred.await(waiter).pipe(
					Effect.timeoutOption('5 seconds'),
					Effect.ensuring(
						Effect.sync(() => {
							waiters.delete(waiter);
						})
					)
				);
				yield* visible(initiatingFiber);
			});
		const answer = (read: WireRead) =>
			Effect.gen(function* () {
				const response = yield* transport.request('POST', PATHS.q, { reads: [read] });
				const refusal = errorOf(response.body);
				if (Option.isSome(refusal)) return yield* Effect.fail(new ReadFailed(refusal.value.error));
				const body = yield* decode(QReply, response.body).pipe(
					Effect.mapError((error) => new ReadFailed({ code: 'protocol', message: error.message }))
				);
				const first = body.answers[0];
				if (first === undefined)
					return yield* Effect.fail(
						new ReadFailed({ code: 'protocol', message: 'The host returned no read answer.' })
					);
				return typed(first);
			});
		const q = <T>(method: WireRead['m'], args: readonly Wired[]): Query<T> => {
			const read: WireRead = { m: method, a: args.map(encodeWire) };
			const once = answer(read).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (!(method === 'query' && isRow(args[1]) && args[1]['revision'] !== undefined))
							track(value);
					})
				),
				Effect.map((value) => value as T)
			);
			return Object.assign(reactiveQuery(once, observe<T>({ read })), { read });
		};
		function observe<T>(query: {
			readonly read: WireRead;
		}): Stream.Stream<T, ReadFailed | TransportFailed> {
			if (config.poll !== undefined)
				// a dropped request is asked again on the next tick, as a stream reconnects
				return Stream.fromEffectSchedule(
					answer(query.read).pipe(
						Effect.tap((value) => Effect.sync(() => track(value))),
						Effect.map(Option.some),
						Effect.catchTag('TransportFailed', () => Effect.succeed(Option.none<Json>()))
					),
					Schedule.spaced(config.poll)
				).pipe(
					Stream.filter(Option.isSome),
					Stream.map((some) => some.value),
					Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
					Stream.map((value) => value as T)
				);
			const key = JSON.stringify(query.read);
			return Stream.unwrap(
				Effect.gen(function* () {
					let view = [...views.values()].find((item) => item.key === key);
					if (view === undefined) {
						view = {
							id: `v${++n}`,
							key,
							read: query.read,
							server: undefined,
							v: 0,
							consumers: new Set(),
							registered: false,
							state: yield* SubscriptionRef.make<ViewState>({
								value: undefined,
								error: undefined,
								sequence: 0
							})
						};
						views.set(view.id, view);
					}
					const current = view;
					yield* FiberMap.remove(grace, current.id);
					const consumer: ViewConsumer = {
						fiberId: yield* Effect.fiberId,
						delivered: yield* SubscriptionRef.make(0)
					};
					current.consumers.add(consumer);
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							current.consumers.delete(consumer);
							yield* SubscriptionRef.set(consumer.delivered, Infinity);
							if (current.consumers.size !== 0) return;
							yield* FiberMap.run(
								grace,
								current.id,
								Effect.sleep('30 seconds').pipe(
									Effect.flatMap(() =>
										Effect.gen(function* () {
											views.delete(current.id);
											if (current.registered) yield* register([], [current.id]);
											if (views.size === 0 && closed === null)
												yield* SubscriptionRef.set(status, 'idle');
										})
									)
								)
							);
						})
					);
					if (closed === null)
						yield* SubscriptionRef.set(status, conn === null ? 'connecting' : 'live');
					yield* Stream.runDrain(frames).pipe(Effect.forkScoped);
					if (!current.registered) yield* register([current]).pipe(Effect.forkScoped);
					return SubscriptionRef.changes(current.state).pipe(
						Stream.flatMap((state) => {
							if (state.error !== undefined) return Stream.fail(state.error);
							const acknowledge = Stream.fromEffect(
								SubscriptionRef.set(consumer.delivered, state.sequence)
							).pipe(Stream.drain);
							// This continuation runs after the downstream pull has consumed the value.
							return state.value === undefined
								? acknowledge
								: Stream.succeed(state.value as T).pipe(Stream.concat(acknowledge));
						})
					);
				})
			);
		}
		const send = (
			callable: string,
			input: Wired,
			key: string,
			observed?: Readonly<Record<string, number>>,
			initiatingFiber?: number
		) =>
			Effect.gen(function* () {
				const issuedAt =
					config.now === undefined
						? yield* Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())
						: config.now();
				const response = yield* transport.request(
					'POST',
					PATHS.act,
					{
						callable,
						input: encodeWire(input),
						issuedAt,
						...(observed === undefined ? {} : { observed })
					},
					{
						[HEADERS.key]: key,
						...(config.contract === undefined ? {} : { [HEADERS.contract]: config.contract })
					}
				);
				const refusal = errorOf(response.body);
				if (Option.isSome(refusal)) {
					const code = refusalOfStatus(response.status);
					return code === null
						? { kind: 'unknown' as const, invocation: key }
						: { kind: 'refused' as const, code, message: refusal.value.error.message };
				}
				const reply = yield* decode(ActReply, response.body);
				if (reply.outcome.kind === 'committed' || reply.outcome.kind === 'pendingApproval')
					yield* caughtUp(reply.v, initiatingFiber);
				return reply.outcome.kind === 'committed'
					? { ...reply.outcome, output: typed(reply.outcome.output) }
					: reply.outcome;
			}).pipe(Effect.catch(() => Effect.succeed({ kind: 'unknown' as const, invocation: key })));
		const act = (
			callable: string,
			input: Wired,
			options: { key?: string; observed?: Readonly<Record<string, number>> } = {}
		) =>
			Effect.gen(function* () {
				const initiatingFiber = yield* Effect.fiberId;
				const wireInput = encodeWire(input);
				const dot = callable.lastIndexOf('.'),
					collection = callable.slice(0, dot),
					verb = callable.slice(dot + 1);
				const key = options.key ?? uuid();
				let observed = options.observed === undefined ? undefined : { ...options.observed };
				if (options.observed === undefined && (verb === 'update' || verb === 'delete'))
					for (const item of list(wireInput))
						for (const id of list(isRow(item) ? (item['target'] ?? null) : null)) {
							const revision = revisions.get(String(id));
							if (revision !== undefined) (observed ??= {})[String(id)] = revision;
						}
				const paint = PAINTED.has(verb) ? paintOf(collection, verb, wireInput, key) : null;
				if (paint !== null) paints.add(paint);
				const request = Effect.gen(function* () {
					if (paint !== null) yield* repaint(collection, initiatingFiber);
					return yield* send(callable, input, key, observed, initiatingFiber).pipe(
						Effect.flatMap(settled)
					);
				});
				return yield* request.pipe(
					Effect.ensuring(
						Effect.gen(function* () {
							if (paint !== null) {
								paints.delete(paint);
								yield* repaint(collection, initiatingFiber);
							}
						})
					)
				);
			});
		const getValue = <A>(
			path: string,
			schema: Schema.Codec<A, unknown>,
			absent?: A,
			failureMessage = 'The host refused the request.'
		) =>
			Effect.gen(function* () {
				const response = yield* transport.request('GET', path);
				if (response.status === 404 && absent !== undefined) return absent;
				if (response.status >= 400 && Option.isNone(errorOf(response.body)))
					return yield* Effect.fail(new ProtocolFailed({ message: failureMessage }));
				const refusal = errorOf(response.body);
				if (Option.isSome(refusal))
					return yield* Effect.fail(new ProtocolFailed({ message: refusal.value.error.message }));
				return yield* decode(schema, response.body);
			});
		const session = (path: string, body: Json) =>
			transport.request('POST', path, body).pipe(
				Effect.mapError(() => new Refusal({ message: 'The workspace could not be reached.' })),
				Effect.flatMap((response) => {
					const refusal = errorOf(response.body);
					return response.status < 400
						? Effect.void
						: Effect.fail(
								new Refusal({
									message: Option.isSome(refusal)
										? refusal.value.error.message
										: 'The request failed.'
								})
							);
				})
			);
		return {
			aggregate: <T = Row[]>(collection: string, options: Wired) =>
				q<T>('aggregate', [collection, options]),
			history: <T = Json>(collection: string, id: string, options: { at?: Json } = {}) =>
				q<T>('history', [collection, id, ...(options.at === undefined ? [] : [options.at])]),
			query: <T = Json>(name: string | Readonly<Record<string, Wired>>, input?: Wired) =>
				q<T>('query', typeof name === 'string' ? [name, input ?? {}] : [name]),
			/** Internal stream edge for shell surfaces. Pages read Query properties directly. */
			observe,
			clock: (unit?: 'minute' | 'hour' | 'day') =>
				reactiveClock(
					(at) => ({
						now: Instant(at),
						today: PlainDate(
							new Intl.DateTimeFormat('en-CA', {
								timeZone: config.tz ?? 'UTC',
								year: 'numeric',
								month: '2-digit',
								day: '2-digit'
							}).format(at)
						)
					}),
					unit,
					config.tz,
					() => (config.now === undefined ? new Date() : new Date(config.now()))
				),
			act,
			recordCapabilities: (collection: string, id: string, parent?: RecordParentContext) =>
				getValue(
					`${PATHS.recordCapabilities}?${new URLSearchParams({
						collection,
						id,
						...(parent === undefined
							? {}
							: {
									parentCollection: parent.collection,
									parentId: parent.id,
									relation: parent.relation,
									parentRevision: String(parent.revision)
								})
					})}`,
					Schema.NullOr(CapabilitiesAnswer),
					null,
					'Record permissions could not be loaded.'
				).pipe(Effect.map((answer) => answer?.value ?? null)),
			decode(collection: string, view: { where?: Json; orderBy?: Json }) {
				if (config.catalog === undefined)
					throw new Error('This client has no catalog to decode against.');
				return storeSync(
					decodeView((decoder ??= browserCatalog(config.catalog)), collection, view)
				);
			},
			...(config.describe === true
				? {
						describe: (
							collection: string,
							text: string,
							fields?: readonly {
								name: string;
								label: string;
								kind: 'text' | 'number' | 'bool';
								optional?: boolean;
							}[]
						) =>
							act('filter.describe', {
								collection,
								text,
								...(fields === undefined ? {} : { fields })
							}).pipe(
								Effect.timeoutOrElse({
									duration: '15 seconds',
									orElse: () => Effect.fail(new DescribeTimeout())
								}),
								Effect.flatMap((outcome) =>
									outcome.kind === 'committed'
										? decode(
												Schema.Struct({
													where: Schema.Json,
													orderBy: Schema.optionalKey(Schema.Json)
												}),
												outcome.output
											)
										: Effect.fail(
												new ProtocolFailed({
													message: 'Could not build a filter from that description.'
												})
											)
								)
							)
					}
				: {}),
			options: (
				collection: string,
				fields?: readonly {
					name: string;
					label: string;
					kind: 'text' | 'number' | 'bool';
					optional?: boolean;
				}[]
			) =>
				act('filter.options', { collection, ...(fields === undefined ? {} : { fields }) }).pipe(
					Effect.flatMap((outcome) =>
						outcome.kind === 'committed'
							? decode(FilterOptionsAnswer, outcome.output)
							: Effect.fail(new ProtocolFailed({ message: 'Could not load filter options.' }))
					)
				),
			// many inputs are one request queueing one run each (a bulk action), not one request per record
			start(automation: string, input: Wired | readonly Wired[]) {
				const inputs: readonly Wired[] = Array.isArray(input) ? input : [input];
				const runs = inputs.map((one) => ({
					input: one,
					id: uuid()
				}));
				const ids = runs.map((run) => run.id),
					id = ids[0]!;
				return Object.assign(send('start', { automation, runs }, id), { id, ids, automation });
			},
			upload: (
				file: Blob & { name?: string },
				field: string
			): Effect.Effect<FileRef, ActRefused | TransportFailed> =>
				transport
					.upload(`${PATHS.files}${encodeURIComponent(field)}`, file, {
						[HEADERS.key]: uuid(),
						'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name ?? 'file')}`
					})
					.pipe(
						Effect.flatMap((response): Effect.Effect<FileRef, ActRefused | ProtocolFailed> => {
							const refusal = errorOf(response.body);
							return Option.isSome(refusal)
								? Effect.fail(new ActRefused(refusal.value.error))
								: decode(FileAnswer, response.body).pipe(
										Effect.map((file) => ({
											...(isRow(response.body) ? (typed(response.body) as Row) : {}),
											...file
										}))
									);
						}),
						Effect.mapError((error) =>
							error instanceof ProtocolFailed ? new TransportFailed({ status: 0 }) : error
						)
					),
			fileUrl: (ref: { readonly id: string }, options: FileUrlOptions = {}) =>
				storedFileUrl(base, ref.id, options),
			convert: (
				source: ConvertSource,
				request: ConvertRequest
			): Effect.Effect<FileRef, ActRefused | TransportFailed | Unavailable> =>
				Effect.gen(function* () {
					const issuedAt =
						config.now === undefined
							? yield* Effect.map(Clock.currentTimeMillis, (millis) =>
									new Date(millis).toISOString()
								)
							: config.now();
					const response = yield* transport.request(
						'POST',
						PATHS.act,
						{
							callable: 'convert.document',
							input: encodeWire({ source, request }),
							issuedAt
						},
						{
							[HEADERS.key]: uuid(),
							...(config.contract === undefined ? {} : { [HEADERS.contract]: config.contract })
						}
					);
					const refusal = errorOf(response.body);
					if (Option.isSome(refusal)) {
						if (refusal.value.error.code === 'unavailable')
							return yield* Effect.fail(
								new Unavailable({
									facility: 'convert.document',
									reason: refusal.value.error.message
								})
							);
						const code = refusalOfStatus(response.status);
						return yield* Effect.fail(
							code === null
								? new TransportFailed({ status: response.status })
								: new ActRefused({ code, message: refusal.value.error.message })
						);
					}
					const { outcome } = yield* decode(ActReply, response.body);
					if (outcome.kind === 'refused') return yield* Effect.fail(new ActRefused(outcome));
					if (outcome.kind !== 'committed')
						return yield* Effect.fail(
							new ProtocolFailed({ message: 'The document could not be converted.' })
						);
					return yield* decode(FileAnswer, encodeWire(outcome.output));
				}).pipe(
					Effect.mapError((error) =>
						error instanceof ProtocolFailed ? new TransportFailed({ status: 0 }) : error
					)
				),
			// a per-record restore (rule 17), never point-in-time recovery or a source rollback
			restore: {
				preview: (collection: string, record: string, revision: number) =>
					act('history.preview', { collection, record, revision }).pipe(
						Effect.flatMap((outcome) =>
							outcome.kind === 'committed'
								? decode(RestorePreviewSchema, encodeWire(outcome.output))
								: Effect.fail(
										new ProtocolFailed({ message: 'The restore preview could not be loaded.' })
									)
						),
						// values as the record body reads them (a decimal revived)
						Effect.map((preview) => ({
							...preview,
							changes: preview.changes.map((c) => ({
								...c,
								current: typed(c.current),
								restored: typed(c.restored)
							})),
							skipped: preview.skipped.map((c) => ({
								...c,
								current: typed(c.current),
								restored: typed(c.restored)
							}))
						}))
					),
				run: (collection: string, record: string, revision: number, live: number) =>
					act('history.restore', { collection, record, revision }, { observed: { [record]: live } })
			},
			approvals: {
				decide: (
					requestId: string,
					decision: { decision: 'approve' | 'reject' | 'requestChanges'; reason?: string }
				) => act('approvals.decide', { requestId, ...decision }),
				get: (requestId: string) =>
					getValue(
						`${PATHS.approval}?id=${encodeURIComponent(requestId)}`,
						Schema.NullOr(Schema.Struct({ value: Schema.Json })),
						null
					).pipe(
						Effect.map((answer) =>
							answer === null ? null : (typed(answer.value) as ApprovalView | null)
						)
					),
				list: (
					filter: {
						collection?: string;
						records?: readonly string[];
						ids?: readonly string[];
						all?: boolean;
					} = {}
				) => {
					const params = new URLSearchParams();
					if (filter.collection !== undefined) params.set('collection', filter.collection);
					for (const record of filter.records ?? []) params.append('record', record);
					for (const request of filter.ids ?? []) params.append('request', request);
					if (filter.all === true) params.set('all', '1');
					return getValue(
						`${PATHS.approval}?${params}`,
						Schema.Struct({ value: Schema.Array(Schema.Json) })
					).pipe(Effect.map((answer) => answer.value.map(typed) as ApprovalView[]));
				}
			},
			session: {
				sendCode: (address: string) => session(PATHS.session.code, { address }),
				verify: (address: string, code: string) =>
					session(PATHS.session.verify, { address, code }).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (typeof location !== 'undefined') location.reload();
							})
						)
					)
			},
			actor: config.actor,
			locale: config.locale,
			t: (key: string, vars: Readonly<Record<string, string | number>> = {}) =>
				(config.messages?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
					vars[name] === undefined ? match : String(vars[name])
				),
			get closed() {
				return closed;
			},
			sync: SubscriptionRef.changes(status)
		};
	});
export type Bolt = Effect.Success<ReturnType<typeof createBolt>>;
export type SyncStatus = 'idle' | 'connecting' | 'live' | 'closed';
