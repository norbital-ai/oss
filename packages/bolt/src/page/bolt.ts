// The scoped browser client: reads and operations are Effects; current reads are Streams.
import {
	Clock,
	DateTime,
	Deferred,
	Effect,
	FiberMap,
	Option,
	Predicate,
	Queue,
	Result,
	Schema,
	Semaphore,
	Stream,
	SubscriptionRef
} from 'effect';
import type { HttpClient } from 'effect/http';
import { tick } from 'svelte';
import type { FileRef, Json } from '../decl/values.ts';
import { reactive_clock, reactive_query, run } from '@norbital-ai/ui/effect';
import type { FileUrlOptions } from '@norbital-ai/store/kind';
import { type ConvertSource, type PreviewPdfOptions, Unavailable, uuidv7 } from '@norbital-ai/host-api';
import { ActConflict, ActRefused, ProtocolFailed, ReadFailed } from '../decl/errors.ts';
import { DescribeTimeout, TransportFailed } from '../decl/errors/browser.ts';
import { ActUnknown } from '../decl/errors/act.ts';
import { Refusal, message_text } from '../decl/errors/refusal.ts';
import type { ActOutcome, EngineActor } from '../engine/contracts.ts';
import {
	RecordCapabilitiesSchema,
	RestorePreviewSchema,
	type RecordParentContext
} from '../protocol/record-contracts.ts';
import { ApprovalViewSchema } from '../protocol/approval-view.ts';
import {
	HEADERS,
	PATHS,
	refusal_of_status,
	type Frame,
	type LiveBody,
	type PatchOp,
	type WireRead
} from '../protocol/wire.ts';
import { ActReply, EngineActorSchema, LiveReply, QReply, WireError, type LocalFilterField } from '../protocol/schema.ts';
import {
	liveStream,
	pageSignals,
	shareable,
	sharedSource,
	type EventSourceLike,
	type Signals
} from './stream.ts';
import { browser_catalog, type BrowserCatalog } from '../protocol/catalog.ts';
import { decode_view, type Catalog } from '@norbital-ai/store';
import type { Query } from './page-bolt.ts';
import { page_reads, readValue } from './read-value.ts';
import { read_wire, type ReadCatalog } from '../protocol/read-answer.ts';
import { act_output, call_output, job_receipt, type OperationOutputs } from '../protocol/output-contract.ts';
import { browserTransport } from '../protocol/client.ts';
import { FileRefSchema, stored_file_url } from './file-ref.ts';


/**
 * The optional document bridge a fleet host uses to inspect mounted snapshot clients without a live stream.
 *
 * Set `window.bolt_live_mode = 'snapshot'` before the page boots; once a client mounts, check that `bolt_refresh`
 * exists and await it before inspecting the page (its absence means no snapshot client is mounted). There is no
 * polling interval. Page code can yield `ctx.refresh()` for the same re-read; a normal tab re-registers its views over
 * its stream instead. Queries keep a failure until a later good answer, so a refresh can recover them.
 *
 * @example
 * await window.bolt_refresh?.();
 */
export interface PageSnapshotHost {
	/** Set before the page boots; absent or `stream` keeps normal browser streaming. */
	bolt_live_mode?: 'stream' | 'snapshot';
	/** Installed read-only while snapshot clients are mounted; removed when the last client's scope closes.
	 * Resolves after their current queries consume refreshed answers and Svelte renders; read failures reject. */
	readonly bolt_refresh?: () => Promise<void>;
}
declare global {
	interface Window extends PageSnapshotHost {}
}

export type BoltConfig = {
	/** Native shape; source identity admission establishes the actor's declared names in this release. */
	actor: EngineActor | null;
	/** The declared results of the automations this caller may start; every committed answer decodes against them. */
	operation_outputs: OperationOutputs;
	locale: string;
	tz?: string;
	messages?: Readonly<Record<string, string>>;
	base?: string;
	fetch?: typeof fetch;
	http_client?: HttpClient.HttpClient;
	open_stream?: (url: string) => EventSourceLike;
	/** A browser without streams reads on mount and explicit refresh, with no polling timer. */
	live?: NonNullable<PageSnapshotHost['bolt_live_mode']>;
	signals?: Signals;
	uuid?: () => string;
	now?: () => string;
	initial_read?: (read: WireRead) => Json | undefined;
	catalog?: BrowserCatalog;
	read_catalog?: ReadCatalog;
	describe?: boolean;
	contract?: string;
	on_notice?: (notice: Row) => void;
};
type Row = { readonly [field: string]: Json };
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
type Paint = { model: string; apply(page: Json): Json };
type ViewState = { value: Json | undefined; error: ReadFailed | TransportFailed | undefined; sequence: number };
type ViewConsumer = {
	readonly fiberId: number;
	readonly delivered: SubscriptionRef.SubscriptionRef<number>;
	readonly validate: (value: Json) => ReadFailed | undefined;
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
/** The fleet marks a document before it boots; ordinary workspace tabs retain streaming. */
export const page_live_mode = (): NonNullable<PageSnapshotHost['bolt_live_mode']> =>
	typeof window !== 'undefined' && Object.getOwnPropertyDescriptor(window, 'bolt_live_mode')?.value === 'snapshot'
		? 'snapshot' : 'stream';
const snapshot_refreshers = new Set<() => Effect.Effect<void, ReadFailed | TransportFailed>>();
/** The host awaits this before inspecting a fleet document, including its next Svelte render. */
const refresh_page: NonNullable<PageSnapshotHost['bolt_refresh']> = () => run(
	Effect.forEach([...snapshot_refreshers], (refresh) => refresh(), { discard: true }).pipe(
		Effect.andThen(Effect.promise(tick))
	)
);
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
	Schema.Struct({
		var: Schema.Literals(['actor.id', 'actor.email', 'actor.party', 'actor.teams'])
	})
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
	Extract<ActOutcome, { kind: 'committed' | 'pending_approval' | 'running' }>,
	ActRefused | ActConflict | ActUnknown
> {
	switch (outcome.kind) {
		case 'committed':
		case 'pending_approval':
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
/** A committed operation already happened: an answer that breaks its declared result is a protocol failure, never a refusal. */
const declared = <A>(schema: () => Schema.Decoder<A>, output: Json) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(schema())(output),
		catch: (error) => new ProtocolFailed({
			message: `The operation committed, but its answer does not match its declared result: ${error instanceof Error ? error.message : String(error)}`
		})
	});
const committedAs = <A>(read: (output: Json) => Effect.Effect<A, ProtocolFailed>, message: string) =>
	(outcome: Effect.Success<ReturnType<typeof settled>>): Effect.Effect<A, ProtocolFailed> =>
		outcome.kind === 'committed' ? read(outcome.output) : Effect.fail(new ProtocolFailed({ message }));
const isRow = (v: Json | undefined): v is Row => Predicate.isObject(v);
const list = (value: Json): readonly Json[] => (jsonArray(value) ? value : [value]);
const RELATION_OPS = ['create', 'update', 'delete', 'upsert', 'link', 'unlink'];
const PAINTED = new Set(['create', 'update', 'delete']);

/** Rule 65: a patch applied to a view's value (a page's `rows`, or a `get`'s row); `undefined` when it does not fit it. */
export function patched(value: Json | undefined, ops: readonly PatchOp[]): Json | undefined {
	if (value === undefined) return undefined;
	const pageRows = isRow(value) ? value['rows'] : undefined;
	let record = isRow(value) ? value : null;
	const page = jsonArray(pageRows);
	let changedRows = false;
	let rows: Json[] = jsonArray(pageRows) ? [...pageRows] : value === null ? [] : [value];
	for (const o of ops) {
		if (o.op === 'meta' || o.op === 'unset') {
			if (record === null) return undefined;
			if (o.op === 'meta') record = { ...record, [o.key]: o.value };
			else { const { [o.key]: _removed, ...rest } = record; record = rest; }
			continue;
		}
		changedRows = true;
		rows = rows.filter(
			(r) => !isRow(r) || r['id'] !== (o.op === 'remove' ? o.id : isRow(o.row) ? o.row['id'] : null)
		);
		if (o.op === 'upsert') {
			if (o.index > rows.length) return undefined;
			rows.splice(o.index, 0, o.row);
		}
	}
	if (page && record !== null) return { ...record, rows };
	if (!changedRows && record !== null) return record;
	return rows.length > 1 ? undefined : (rows[0] ?? null);
}

/** The roots a read request names (`query({ … })`), whose pages a write's paint reaches. */
const rootsOf = (read: WireRead): readonly string[] => {
	const request = read.m === 'query' ? read.a[0] : undefined;
	return isRow(request) ? Object.keys(request).filter((path) => !path.includes('.')) : [];
};
/** The paint of one generated write over each live read request's page of its model. */
function paintOf(model: string, verb: string, input: Json, key: string): Paint {
	const rows = (v: Json, each: (rows: readonly Row[]) => readonly Row[]): Json => {
		const values = isRow(v) ? v['rows'] : undefined;
		if (!isRow(v) || !jsonArray(values) || !values.every(isRow)) return v;
		const painted = each(values);
		const total = v['total'];
		// a painted row in or out of the page moves its `total` with it
		return typeof total === 'number'
			? { ...v, rows: painted, total: total + painted.length - values.length }
			: { ...v, rows: painted };
	};
	if (verb === 'create') {
		const created = list(input).map((x, i): Row => ({
			id: `pending:${key}:${i}`,
			...(isRow(x) ? x : {})
		}));
		return { model, apply: (v) => rows(v, (rs) => [...created, ...rs]) };
	}
	if (verb === 'delete') {
		const gone = new Set(list(input).flatMap((row) => isRow(row) && isRow(row['target']) ? [String(row['target']['id'])] : []));
		return {
			model,
			apply: (v) => rows(v, (rs) => rs.filter((r) => !gone.has(String(r['id']))))
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
			if (isRow(x['target'])) sets.set(String(x['target']['id']), set);
		}
	return {
		model,
		apply: (v) =>
			rows(v, (rs) =>
				rs.map((r) => (sets.has(String(r['id'])) ? { ...r, ...sets.get(String(r['id'])) } : r))
			)
	};
}

export const create_bolt = (config: BoltConfig) =>
	Effect.gen(function* () {
		const actor = yield* decode(Schema.NullOr(EngineActorSchema), config.actor);
		const live_mode = config.live ?? page_live_mode();
		const base = config.base ?? '';
		const transport = browserTransport(config);
		const uuid = config.uuid ?? uuidv7;
		const views = new Map<string, View>();
		const paints = new Set<Paint>();
		const waiters = new Map<Deferred.Deferred<void>, number>();
		const grace = yield* FiberMap.make<string, void, never>();
		const reconnects = yield* Queue.sliding<void>(1);
		const status = yield* SubscriptionRef.make<SyncStatus>('idle');
		const refresh_lock = yield* Semaphore.make(1);
		const live = `${base}${PATHS.live}`;
		// a page's own stream is shared with the browser's other tabs (`sharedSource`); a given `open_stream` is not
		const shared = live_mode !== 'snapshot' && config.open_stream === undefined && shareable();
		const tab = shared ? `${uuid()}:` : '';
		let conn: string | null = null,
			applied = 0,
			n = 0,
			generation = 0;
		let closed: string | null = null,
			decoder: Catalog | undefined;
		let noticeVersion = -1;
		const noticeIds = new Set<string>();
		const validate = (view: View, value: Json): ReadFailed | undefined => {
			for (const consumer of view.consumers) {
				const failure = consumer.validate(value);
				if (failure !== undefined) return failure;
			}
			return undefined;
		};
		const shown = (view: View) => {
			let value = view.server;
			if (value !== undefined)
				for (const paint of paints)
					if (isRow(value) && rootsOf(view.read).includes(paint.model)) {
						const next: Row = { ...value, [paint.model]: paint.apply(value[paint.model] ?? null) };
						// A partial create cannot invent the defaults or computed values of a typed row.
						if (validate(view, next) === undefined) value = next;
					}
			return value;
		};
		const notify = (view: View, error?: ReadFailed | TransportFailed) =>
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
		const repaint = (model: string, initiatingFiber: number) =>
			Effect.gen(function* () {
				const changed = yield* Effect.forEach(
					[...views.values()].filter((view) => rootsOf(view.read).includes(model)),
					(view) => SubscriptionRef.get(view.state).pipe(
						Effect.flatMap((state) => notify(view, state.error)),
						Effect.map((sequence) => ({ view, sequence }))
					)
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
				const answer = yield* transport.request('POST', PATHS.live, body).pipe(
					Effect.flatMap((response) => {
						const refusal = errorOf(response.body);
						return Option.isSome(refusal)
							? Effect.succeed(add.map((view) => ({ view: view.id, ...refusal.value.error })))
							: decode(LiveReply, response.body).pipe(Effect.map((reply) => reply.errors));
					}),
					Effect.result
				);
				if (generation !== registeredGeneration) return;
				if (answer._tag === 'Failure') {
					// a view whose registration failed hears it, instead of waiting for frames that never come
					const failed = new ReadFailed({ code: 'transport', message: answer.failure.message });
					for (const view of add) {
						view.registered = false;
						yield* notify(view, failed);
					}
					return;
				}
				const errors = answer.success;
				if (
					errors.some(
						(error) => error.code === 'not_found' && error.message === 'the live connection is gone'
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
		const receiveNotices = (frame: Extract<Frame, { t: 'answer' | 'patch' }>, view: View | undefined) => {
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
						config.on_notice?.(notice);
					}
			}
		};
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
						closed = null;
						yield* SubscriptionRef.set(status, 'live');
						for (const item of views.values()) {
							item.registered = false;
							item.v = -1;
						}
						yield* register([...views.values()]).pipe(Effect.forkScoped);
						return;
					case 'answer':
						receiveNotices(frame, view);
						if (view !== undefined) {
							if (frame.v < view.v) return yield* advance(frame.v);
							const failure = validate(view, frame.value);
							if (failure !== undefined) {
								yield* notify(view, failure);
								view.server = undefined;
								view.registered = false;
								return yield* advance(frame.v);
							}
							view.server = frame.value;
							view.v = frame.v;
							yield* notify(view);
						}
						return yield* advance(frame.v);
					case 'patch': {
						if (view === undefined || frame.v <= view.v) return yield* advance(frame.v);
						const next = patched(
							view.server,
							frame.ops
						);
						if (next === undefined) {
							view.registered = false;
							return yield* register([view]);
						}
						const failure = validate(view, next);
						if (failure !== undefined) {
							yield* notify(view, failure);
							view.server = undefined;
							view.registered = false;
							return yield* register([view]);
						}
						receiveNotices(frame, view);
						view.server = next;
						view.v = frame.v;
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
		const open = () => new EventSource(live, { withCredentials: true });
		// a shared connection outlives this tab's part in it: the tab's views are dropped from it, not left running
		const leave = () => {
			const drop = [...views.values()].filter((view) => view.registered).map((view) => view.id);
			if (!shared || conn === null || drop.length === 0) return;
			const body: LiveBody = { conn, drop };
			void (config.fetch ?? fetch)(live, {
				method: 'POST',
				keepalive: true,
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}).catch(() => undefined);
		};
		if (shared) {
			window.addEventListener('pagehide', leave);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => window.removeEventListener('pagehide', leave))
			);
		}
		const frames = live_mode === 'snapshot' ? Stream.empty : yield* liveStream(
			() => config.open_stream?.(live) ?? (shared ? sharedSource(live, open) : open()),
			Effect.gen(function* () {
				leave();
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
				// A read failure must not turn an acknowledged write into an uncertain write.
				if (live_mode === 'snapshot') return yield* refresh(initiatingFiber).pipe(Effect.ignore);
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
				return first;
			});
		const read_view = (view: View) =>
			Effect.gen(function* () {
				const before = yield* SubscriptionRef.get(view.state);
				const result = yield* Effect.result(answer(view.read));
				const current = yield* SubscriptionRef.get(view.state);
				// A streamed frame that arrived during this request owns the newer image.
				if (current.sequence !== before.sequence || views.get(view.id) !== view) return;
				if (Result.isFailure(result)) {
					yield* notify(view, result.failure);
					return yield* Effect.fail(result.failure);
				}
				const failure = validate(view, result.success);
				if (failure !== undefined) {
					yield* notify(view, failure);
					return yield* Effect.fail(failure);
				}
				// an unchanged answer over a settled image is not repeated
				const unchanged = current.error === undefined && view.server !== undefined &&
					JSON.stringify(view.server) === JSON.stringify(result.success);
				view.server = result.success;
				if (!unchanged) yield* notify(view);
			});
		const refresh = (initiating_fiber?: number) => Effect.gen(function* () {
			const active = [...views.values()].filter((view) => view.consumers.size > 0);
			if (live_mode === 'snapshot') {
				const results = yield* refresh_lock.withPermit(Effect.forEach(
					active, (view) => Effect.result(read_view(view))
				));
				yield* visible(initiating_fiber);
				for (const result of results)
					if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
				return;
			}
			if (active.length === 0) return;
			if (closed !== null) return yield* Effect.fail(new ReadFailed({ code: 'closed', message: 'The workspace release has changed. Reopen the page.' }));
			const before = yield* Effect.forEach(active, (view) => SubscriptionRef.get(view.state).pipe(
				Effect.map((state) => ({ view, sequence: state.sequence }))
			));
			if (conn === null) yield* Queue.offer(reconnects, undefined);
			else yield* register(active);
			const updated = yield* Effect.forEach(before, ({ view, sequence }) => SubscriptionRef.changes(view.state).pipe(
				Stream.filter((state) => state.sequence > sequence),
				Stream.take(1),
				Stream.runHead
			), { concurrency: 'unbounded' }).pipe(Effect.timeoutOption('5 seconds'));
			if (Option.isNone(updated)) return yield* Effect.fail(new ReadFailed({ code: 'transport', message: 'The workspace did not finish refreshing. Try again.' }));
			yield* visible(initiating_fiber);
			for (const state of updated.value)
				if (Option.isSome(state) && state.value.error !== undefined) return yield* Effect.fail(state.value.error);
		});
		if (live_mode === 'snapshot' && typeof window !== 'undefined') {
			const owned_refresh = () => Effect.fiberId.pipe(Effect.flatMap(refresh));
			snapshot_refreshers.add(owned_refresh);
			Object.defineProperty(window, 'bolt_refresh', { configurable: true, value: refresh_page });
			yield* Effect.addFinalizer(() => Effect.sync(() => {
				snapshot_refreshers.delete(owned_refresh);
				if (snapshot_refreshers.size === 0 && Object.getOwnPropertyDescriptor(window, 'bolt_refresh')?.value === refresh_page)
					Reflect.deleteProperty(window, 'bolt_refresh');
			}));
		}
		const q = <A>(method: WireRead['m'], args: readonly Json[], schema: () => Schema.Decoder<A>): Query<A> => {
			const read: WireRead = { m: method, a: args.map(read_wire) };
			let prepared: Schema.Decoder<A> | undefined;
			const decoder = () => prepared ?? (prepared = schema());
			const once = answer(read).pipe(
				Effect.flatMap((value) => Effect.fromResult(readValue(decoder, value)))
			);
			const seeded = config.initial_read?.(read);
			const initial = seeded === undefined ? undefined : readValue(decoder, seeded);
			const updates = observe_results({ read }, decoder);
			return Object.assign(reactive_query(once,
				initial !== undefined && Result.isFailure(initial) ? Stream.concat(Stream.succeed(initial), updates) : updates,
				initial !== undefined && Result.isSuccess(initial) ? Option.some(initial.success) : Option.none<A>()
			), { read });
		};
		function observe_results<A>(query: {
			readonly read: WireRead;
		}, schema: () => Schema.Decoder<A>): Stream.Stream<Result.Result<A, ReadFailed | TransportFailed>> {
			const key = JSON.stringify(query.read);
			return Stream.unwrap(
				Effect.gen(function* () {
					let view = [...views.values()].find((item) => item.key === key);
					if (view === undefined) {
						view = {
							id: `${tab}v${++n}`,
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
						delivered: yield* SubscriptionRef.make(0),
						validate: (value) => {
							const decoded = readValue(schema, value);
							return Result.isFailure(decoded) ? decoded.failure : undefined;
						}
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
					if (live_mode === 'snapshot') {
						yield* refresh_lock.withPermit(Effect.result(read_view(current)));
					} else {
						if (closed === null)
							yield* SubscriptionRef.set(status, conn === null ? 'connecting' : 'live');
						yield* Stream.runDrain(frames).pipe(Effect.forkScoped);
						if (!current.registered) yield* register([current]).pipe(Effect.forkScoped);
					}
					return SubscriptionRef.changes(current.state).pipe(
						Stream.flatMap((state) => {
							const acknowledge = Stream.fromEffect(
								SubscriptionRef.set(consumer.delivered, state.sequence)
							).pipe(Stream.drain);
							// This continuation runs after the downstream pull has consumed the value.
							const result = state.error !== undefined
								? Result.fail(state.error)
								: state.value === undefined ? undefined : readValue(schema, state.value);
							return result === undefined
								? acknowledge
								: Stream.succeed(result).pipe(Stream.concat(acknowledge));
						})
					);
				})
			);
		}
		const observe = <A>(query: { readonly read: WireRead }, schema: Schema.Decoder<A>) => observe_results(query, () => schema).pipe(
			Stream.flatMap((result) => Result.isSuccess(result) ? Stream.succeed(result.success) : Stream.fail(result.failure))
		);
		const post = <A, E, R>(
			prepare: (issued_at: string) => { readonly body: Json; readonly key: string },
			request: (body: Json, headers: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>
		) => Effect.gen(function* () {
			const issued_at = config.now === undefined
				? yield* Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())
				: config.now();
			const { body, key } = prepare(issued_at);
			return yield* request(body, {
				[HEADERS.key]: key,
				...(config.contract === undefined ? {} : { [HEADERS.contract]: config.contract })
			});
		});
		const send = (
			body: Readonly<Record<string, Json>>,
			key: string,
			observed?: Readonly<Record<string, number>>,
			initiatingFiber?: number,
			path: string = PATHS.act
		) =>
			Effect.gen(function* () {
				const response = yield* post((issued_at) => ({
					body: { ...body, issued_at, ...(observed === undefined ? {} : { observed }) }, key
				}), (body, headers) => transport.request('POST', path, body, headers));
				const refusal = errorOf(response.body);
				if (Option.isSome(refusal)) {
					// `busy` is the host's admission refusal: nothing ran, so the person may simply try again
					const code =
						refusal.value.error.code === 'busy' ? 'rate_limited' : refusal_of_status(response.status);
					return code === null
						? { kind: 'unknown' as const, invocation: key }
						: { kind: 'refused' as const, code, message: refusal.value.error.message };
				}
				const reply = yield* decode(ActReply, response.body);
				if (reply.outcome.kind === 'committed' || reply.outcome.kind === 'pending_approval')
					yield* caughtUp(reply.v, initiatingFiber);
				return reply.outcome;
			}).pipe(Effect.catch(() => Effect.succeed({ kind: 'unknown' as const, invocation: key })));
		/** A queue admission commits exactly the receipt of the runs this client allocated; anything else is a failure. */
		const admit = (body: Readonly<Record<string, Json>>, key: string, automation: string, ids: readonly string[], path?: string) =>
			send(body, key, undefined, undefined, path).pipe(Effect.flatMap(settled), Effect.flatMap((outcome) =>
				outcome.kind === 'committed'
					? Effect.map(declared(() => job_receipt(automation, ids), outcome.output), (output) => ({ ...outcome, output }))
					: Effect.fail(new ProtocolFailed({ message: 'A run admission answered without committing its receipt.' }))));
		const command = (callable: string, input: Json, options: { observed?: Readonly<Record<string, number>> } = {}) =>
			send({ callable, input }, uuid(), options.observed).pipe(Effect.flatMap(settled));
		const act = (
			inputs: Readonly<Record<string, Json>>,
			options: { key?: string } = {}
		) => Effect.gen(function* () {
			const initiatingFiber = yield* Effect.fiberId;
			const key = options.key ?? uuid();
			const acts = inputs;
			const pending = Object.entries(acts).flatMap(([name, input]) => {
				const dot = name.lastIndexOf('.');
				const model = name.slice(0, dot), verb = name.slice(dot + 1);
				return PAINTED.has(verb) ? [paintOf(model, verb, input, key)] : [];
			});
			for (const paint of pending) paints.add(paint);
			const repaintAll = Effect.forEach([...new Set(pending.map((paint) => paint.model))], (model) => repaint(model, initiatingFiber), { discard: true });
			return yield* Effect.gen(function* () {
				yield* repaintAll;
				const outcome = yield* send({ acts }, key, undefined, initiatingFiber).pipe(Effect.flatMap(settled));
				return outcome.kind === 'committed'
					? { ...outcome, output: yield* declared(() => act_output(acts), outcome.output) }
					: outcome;
			}).pipe(Effect.ensuring(Effect.gen(function* () {
				for (const paint of pending) paints.delete(paint);
				yield* repaintAll;
			})));
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
			refresh: () => Effect.fiberId.pipe(Effect.flatMap(refresh)),
			...page_reads(config.read_catalog, q),
			/** Native controls bind runtime-built requests to their actual answer codec. */
			native_query: <A>(read: WireRead, schema: Schema.Decoder<A>) => q(read.m, read.a, () => schema),
			/** Internal stream edge for shell surfaces. Pages read Query properties directly. */
			observe,
			clock: (unit?: 'minute' | 'hour' | 'day') =>
				reactive_clock(
					(at) => ({
						now: at.toISOString(),
						today: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(at, { timeZone: config.tz ?? 'UTC' }))
					}),
					unit,
					config.tz,
					() => (config.now === undefined ? new Date() : new Date(config.now()))
				),
			act,
			record_capabilities: (model: string, id: string, parent?: RecordParentContext) =>
				getValue(
					`${PATHS.record_capabilities}?${new URLSearchParams({
						model,
						id,
						...(parent === undefined
							? {}
							: {
									parent_model: parent.model,
									parent_id: parent.id,
									relation: parent.relation,
									parent_revision: String(parent.revision)
								})
					})}`,
					Schema.NullOr(CapabilitiesAnswer),
					null,
					'Record permissions could not be loaded.'
				).pipe(Effect.map((answer) => answer?.value ?? null)),
			delete_verdict: (model: string, ids: readonly string[]) =>
				getValue(
					`${PATHS.delete_verdict}?${new URLSearchParams([['model', model], ...ids.map((id) => ['id', id])])}`,
					Schema.Struct({ value: Schema.Literals(['allow', 'approve', 'refuse']) }),
					undefined,
					'Delete permissions could not be loaded.'
				).pipe(Effect.map((answer) => answer.value)),
			decode(model: string, view: { where?: Json; order_by?: Json }) {
				if (config.catalog === undefined)
					throw new Error('This client has no catalog to decode against.');
				// the page edge runs the decoder; an unknown model drops the whole view
				return Effect.runSync(
					decode_view((decoder ??= browser_catalog(config.catalog)), model, view).pipe(
						Effect.catch((error) =>
							Effect.succeed({ where: {}, dropped: [{ path: '', message: error.message }] })
						)
					)
				);
			},
			...(config.describe === true
				? {
						describe: (
							model: string,
							text: string,
							fields?: readonly LocalFilterField[]
						) =>
							command('filter.describe', {
								model,
								text,
								...(fields === undefined ? {} : { fields })
							}).pipe(
								Effect.timeoutOrElse({
									duration: '15 seconds',
									orElse: () => Effect.fail(new DescribeTimeout())
								}),
								Effect.flatMap(committedAs((output) => decode(Schema.Struct({
									where: Schema.optionalKey(Schema.Json), order_by: Schema.optionalKey(Schema.Json)
								}), output), 'Could not build a filter from that description.'))
							)
					}
				: {}),
			options: (
				model: string,
				fields?: readonly LocalFilterField[]
			) =>
				command('filter.options', { model, ...(fields === undefined ? {} : { fields }) }).pipe(
					Effect.flatMap(committedAs((output) => decode(FilterOptionsAnswer, output), 'Could not load filter options.'))
				),
			/** Native controls retain durable execution tracking without exposing syncs as automation starts. */
			sync_control(model: string, sync: string, input: Json) {
				const id = uuid(), automation = `${model}.sync.${sync}`;
				return Object.assign(admit({ model, sync, id, input }, id, automation, [id], PATHS.sync_control),
					{ mode: 'job' as const, id, ids: [id], automation });
			},
			// many inputs are one request queueing one run each (a bulk action), not one request per record
			run(automation: string, input: Json | readonly Json[]) {
				const declared_call = Object.hasOwn(config.operation_outputs.automations, automation)
					? config.operation_outputs.automations[automation] : undefined;
				if (declared_call?.mode === 'call')
					return Object.assign(command('run', { automation, input }).pipe(Effect.flatMap((answer) => answer.kind === 'committed'
						? declared(() => call_output(config.operation_outputs, automation), answer.output)
						: Effect.fail(new ProtocolFailed({ message: 'A call answered with a durable run outcome instead of its result.' })))), { mode: 'call' as const, automation });
				const inputs: readonly Json[] = Array.isArray(input) ? input : [input];
				const runs = inputs.map((one) => ({
					input: one,
					id: uuid()
				}));
				const ids = runs.map((run) => run.id);
				const id = ids[0];
				if (id === undefined) throw new RangeError('An automation batch needs at least one input.');
				return Object.assign(admit({ callable: 'run', input: { automation, runs } }, id, automation, ids), { mode: 'job' as const, id, ids, automation });
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
								: decode(FileAnswer, response.body);
						}),
						Effect.mapError((error) =>
							error instanceof ProtocolFailed ? new TransportFailed({ status: 0 }) : error
						)
					),
			file_url: (ref: { readonly id: string }, options: FileUrlOptions = {}) =>
				stored_file_url(base, ref.id, options),
			preview_pdf: (source: ConvertSource, options: PreviewPdfOptions = {}) =>
				Effect.gen(function* () {
					const response = yield* post((issued_at) => ({
						body: { callable: 'convert.previewPdf', input: { source, options }, issued_at }, key: uuid()
					}), (body, headers) => transport.requestPdf(PATHS.act, body, headers));
					if (response.body instanceof Uint8Array) return response.body;
					const refusal = errorOf(response.body);
					if (Option.isSome(refusal) && refusal.value.error.code === 'unavailable')
						return yield* new Unavailable({
							facility: 'convert.previewPdf',
							reason: refusal.value.error.message
						});
					const outcome = Schema.decodeUnknownOption(ActReply)(response.body);
					if (Option.isSome(outcome) && outcome.value.outcome.kind === 'refused')
						return yield* new ActRefused(outcome.value.outcome);
					const code = refusal_of_status(response.status);
					if (code !== null && Option.isSome(refusal))
						return yield* new ActRefused({ code, message: refusal.value.error.message });
					return yield* new TransportFailed({ status: response.status });
				}),
			// a per-record restore, never point-in-time recovery or a source rollback
			restore: {
				preview: (model: string, record: string, revision: number) =>
					command('history.preview', { model, record, revision }).pipe(
						Effect.flatMap(committedAs((output) => decode(RestorePreviewSchema, output), 'The restore preview could not be loaded.')),
					),
				run: (model: string, record: string, revision: number, live: number) =>
					command('history.restore', { model, record, revision }, { observed: { [record]: live } })
			},
			approvals: {
				decide: (
					request_id: string,
					decision: {
						decision: 'approve' | 'reject' | 'request_changes' | 'withdraw';
						reason?: string;
					}
				) => command('approvals.decide', { request_id, ...decision }),
				get: (request_id: string) =>
					getValue(
						`${PATHS.approval}?id=${encodeURIComponent(request_id)}`,
						Schema.NullOr(Schema.Struct({ value: Schema.NullOr(ApprovalViewSchema) })),
						null
					).pipe(Effect.map((answer) => answer?.value ?? null)),
				list: (
					filter: {
						model?: string;
						records?: readonly string[];
						ids?: readonly string[];
						all?: boolean;
					} = {}
				) => {
					const params = new URLSearchParams();
					if (filter.model !== undefined) params.set('model', filter.model);
					for (const record of filter.records ?? []) params.append('record', record);
					for (const request of filter.ids ?? []) params.append('request', request);
					if (filter.all === true) params.set('all', '1');
					return getValue(
						`${PATHS.approval}?${params}`,
						Schema.Struct({ value: Schema.Array(ApprovalViewSchema) })
					).pipe(Effect.map((answer) => answer.value));
				}
			},
			session: {
				send_code: (address: string) => session(PATHS.session.code, { address }),
				verify: (address: string, code: string) =>
					session(PATHS.session.verify, { address, code }).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (typeof location !== 'undefined') location.reload();
							})
						)
					)
			},
			actor,
			locale: config.locale,
			t: (key: string, vars?: Readonly<Record<string, string | number>>) =>
				message_text(config.messages, key, vars),
			get closed() {
				return closed;
			},
			sync: SubscriptionRef.changes(status)
		};
	});
export type Bolt = Effect.Success<ReturnType<typeof create_bolt>>;
export type SyncStatus = 'idle' | 'connecting' | 'live' | 'closed';
