// The workspace kit is a scoped Effect layer; its callers use the same routes as a real host.
import { input_schema, type Kind } from '@norbital-ai/std/kind';
import {
	audit_from_abi,
	AiPortResponseSchema,
	apply_migrations,
	read_migrations,
	read_applied,
	output_schema,
	audit_shape,
	compile_authority,
	decode_acts,
	AgentHost,
	DOWNLOAD,
	media_type,
	EnvoyConfig,
	RateWindows,
	TenantDb,
	type TenantDbShape,
	DbError,
	type EngineError,
	BoltError,
	EngineLive,
	Live,
	type EngineServices,
	Authorities,
	load_keys,
	logged_phone,
	make_identity_host,
	mint,
	signup_of,
	type IdentityHost,
	decode_manifest,
	layered,
	layers,
	type EngineManifest,
	Port,
	type PortFailure,
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Docs,
	Images,
	Keys,
	Logs,
	Mcp,
	Transport,
	WebRead,
	Browser,
	type TransportMessage,
	lower_read,
	Activation,
	Callables,
	Conversations,
	Envoys,
	Reads,
	RunHandlers,
	Runs,
	SmartThrottle,
	type OutboundFile,
	type ShapeOf,
	duration,
	load_pack,
	read_pack,
	source_of,
	type Pack,
	restore_source,
	seed as restore,
	type SeedPack,
	BoltHost,
	BoltHostLive,
	PublicPages,
	public_pages,
	RateLimits,
	SessionAuthority,
	HostIdentity,
	ShellConfig,
	ShellRoutes,
	Turnstile,
	session_authority,
	type ShellHostConfig
} from '@norbital-ai/bolt/engine';
import { memory_audit } from './audit.ts';
import {
	Diagnostic,
	file_ref,
	BUILTIN_FIELDS,
	nullable_of_expr,
	type Holder,
	with_browser,
	loopback_http_port,
	member_column,
	member_value,
	parse_address,
	syncs_of,
	SYNC_DELIVER,
	IDENTITY,
	catalog,
	bindings,
	plan_read_request,
	type ReadPlan,
	HEADERS,
	PATHS,
	refusal_of_status,
	uuidv7,
	cookie_names,
	node_ports,
	tenant_db_port,
	keys_port,
	loopback_tcp_port,
	schema_slice,
	fingerprint
} from '@norbital-ai/bolt/tooling';
import type {
	AuditRecord,
	Json,
	AiRequest,
	AiPortResponse,
	Authority,
	DriverPage,
	EngineActor,
	FilesPort,
	LogQuery,
	LogRow,
	Sql,
	TransportPort,
	GuestProgram
} from '@norbital-ai/bolt/engine';
import * as EffectVitest from '@effect/vitest';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
	Clock,
	Context,
	Cron,
	type Crypto,
	Duration,
	Effect,
	type Fiber,
	FileSystem,
	Layer,
	type Path,
	Option,
	Predicate,
	Redacted,
	Result,
	Schema,
	SchemaGetter,
	Semaphore
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
	ModelName,
	FileSyncName,
	ReadSyncName,
	SyncControlInput,
	ActMap,
	ActOptions,
	WriteTarget,
	ActInput,
	Callable,
	Committed,
	PendingApproval,
	HistoryOptions,
	ReadRequest,
	ReadRequestBase,
	ReadableName,
	StartInput,
	AutomationName,
	AutomationSpecOf,
	FileRef,
	Id
} from '@norbital-ai/bolt';
import {
	type ActFailure,
	ActRefused,
	ActUnknown,
	act_failure,
	FacilityFailure,
	ReadFailed
} from '@norbital-ai/bolt/errors';
import type { Is } from '@norbital-ai/bolt/tooling';
import { CHECKPOINTS, inputs, keep, prune, tree_hash } from './checkpoint.ts';
import { TestDb } from './database.ts';
import {
	off,
	unmet,
	type Facilities,
	type System1,
	type System2
} from '@norbital-ai/bolt/facilities';
import { facility_layers } from '@norbital-ai/bolt/host-api';
import { node_guests } from '../guests.ts';
import type { Artifact } from '@norbital-ai/bolt/artifact';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import {
	decode_read_request,
	type DynamicRead,
	ActReply,
	QReply,
	WireError
} from '@norbital-ai/bolt/protocol';

/**
 * Effect-aware Vitest helpers: `it.effect` scopes each test, `layer` shares a scoped service layer across a suite,
 * `describe` groups scenarios, and `expect` asserts their values and outcomes.
 */
export const it = EffectVitest.it;
/** Share one scoped Effect service layer across the tests in a suite. */
export const layer = EffectVitest.layer;
/** Group related workspace test scenarios using Vitest's suite lifecycle. */
export const describe = EffectVitest.describe;
/** Assert workspace values and typed operation outcomes with Vitest's matchers. */
export const expect = EffectVitest.expect;
export type { ActOptions } from '@norbital-ai/bolt';
/** The workspace's generated write callables, including model erase operations exercised by the test host. */
export type KitCallable = Callable | `${ReadableName}.erase`;
/** A callable's native typed input; erase operations accept one or more model ids and an optional replacement set. */
export type KitInput<N> = N extends `${infer C}.erase`
	? { target: WriteTarget<C> | readonly WriteTarget<C>[]; set?: Readonly<Record<string, Json>> }
	: ActInput<N>;
/**
 * Reads, writes, approval decisions, uploads and automation starts through the real host routes under one authority, with
	 * native decoded values and typed failures. `query` takes the page's and `ctx.query`'s read request: a layer map of
	 * roots and their declared layers, answered per root. Result schemas describe the running manifest; use an explicit
	 * decoder when a test needs a more specific output type. Writes are batches: `act` takes a
 * map of generated callables to their inputs; a policy `check` that denies fails with `ActRefused` (`rule`, `row`, `path`, `field`), one that
 * approves answers `pending_approval`.
 */
type NativeAnswers = ReturnType<typeof nativeAnswers>;
/** A manifest-dependent query's decoded pages or aggregates; dynamic field values retain their native values. */
export type NativeReadAnswer = Effect.Success<ReturnType<NativeAnswers['read']>>;
/** Actual revision images decoded against the running manifest, without an unrelated authored type claim. */
export type NativeHistory = Effect.Success<ReturnType<NativeAnswers['history']>>;
/** A native map-write outcome, with each import result decoded using its actual model. */
export type NativeActAnswer = Effect.Success<ReturnType<NativeAnswers['map']>>;
/** A native queued-job receipt, including the actual written records or held approval. */
export type NativeJobAnswer = Effect.Success<ReturnType<NativeAnswers['queued']>>;
export interface KitQuery {
	<const R extends ReadRequestBase>(request: ReadRequest<R> | DynamicRead): Effect.Effect<NativeReadAnswer, ReadFailed>;
}
type KitActInput<A extends ActMap> = A & (string extends keyof A
	? Readonly<Record<string, Json>>
	: { readonly [N in keyof A]: N extends KitCallable ? NoInfer<KitInput<N>> : never });
export interface KitAct {
	<const A extends ActMap>(acts: KitActInput<A>, options?: ActOptions): Effect.Effect<NativeActAnswer, ActFailure>;
}
export interface Caller {
	readonly authority: Authority;
	readonly query: KitQuery;
	/**
	 * A record's revisions as the page's `bolt.history` reads them, oldest first; `at` starts from an instant, a revision
	 * or just before an approval request. A record as of a revision: take its `at`, then read the root with `as_of`.
	 */
	history<C extends string>(
		model: Is<C, ReadableName>, id: NoInfer<Id<C>>, options?: HistoryOptions<C>
	): Effect.Effect<NativeHistory, ReadFailed>;
	readonly act: KitAct;
	/** Decodes the native job receipt or call output with the supplied result schema. */
	run<const A extends string, O>(
		automation: Is<A, AutomationName>,
		input: NoInfer<StartInput<A>>,
		output: Schema.Decoder<O>,
		options?: NoInfer<AutomationSpecOf<A> extends { mode: 'call' } ? never : { id?: string }>
	): Effect.Effect<O, ActFailure | Schema.SchemaError>;
	/** Native manual sync control through its real host route. */
	sync_control<const M extends string, const S extends string>(
		model: Is<M, ModelName>, sync: Is<S, FileSyncName<M> | ReadSyncName<M>>,
		input: NoInfer<SyncControlInput<M, S>>, options?: { id?: string }
	): Effect.Effect<NativeJobAnswer, ActFailure>;
	upload(
		field: `${string}.${string}`,
		file: { name: string; mime: string; bytes: Uint8Array; id?: string }
	): Effect.Effect<Committed<FileRef> | PendingApproval, ActFailure>;
	/** `bolt.approvals.decide`: approve, reject or request changes on a request this caller may decide now (a reason for the last two), or withdraw their own. */
	readonly approvals: {
		decide(
			request_id: string,
			input: { decision: 'approve' | 'reject' | 'request_changes' | 'withdraw'; reason?: string }
		): Effect.Effect<void, ActFailure>;
	};
}
const FailedRun = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	error: Schema.NullOr(Schema.String)
});
/** A run that failed, as `run_due` answers it. */
export type FailedRun = typeof FailedRun.Type;
/** `run_due` passes before it dies: a chain longer than this is a run requeueing itself at the same instant. */
const DRAIN_PASSES = 32;
/** Invalid test configuration, fixture input or compiler setup; these failures cannot be mistaken for a business refusal. */
export class KitInvalid extends Schema.TaggedError<KitInvalid>()('KitInvalid', {
	message: Schema.String
}) {}
/** Failures while acquiring or operating a test workspace: invalid fixtures, engine faults, port failures and platform I/O errors. */
export type KitFailure = KitInvalid | EngineError | PortFailure | PlatformError;
/** Ordered AI responses per model class, supplied inline or by a JSON file containing a `turns` array. */
export type Cassette = { readonly [modelClass: string]: readonly AiPortResponse[] | string };
/** AI playback configuration: response cassettes and an optional System 1 responder. */
export type CassetteOptions = {
	cassette: Cassette;
	sys_1?: Ai['Service']['ask'];
};
/**
 * The default integration driver fake, a test's remote system: inspect sent messages and typing notices; `answer` is the
 * remote a sync's `read` and `write` reach through `ctx.request` (a request driver's call: list pages, write acks,
 * refusals): it answers as the driver does, `{ status, body }` with `body` the value `ctx.request` yields (already decoded
 * JSON, not bytes), and `op` is the request as made (`path` is relative to the definition's base URL). `page` is a pushing
 * driver's page of items for a sync (`read`'s `items`, a calendar's events).
 */
export type FakeLinks = {
	readonly sent: { instance: string; message: Json; attachments?: readonly OutboundFile[] }[];
	/** Typing notices in order: `on` shows the assistant typing, `false` stops it. */
	readonly typed: { instance: string; to: string; on: boolean }[];
	answer: (instance: string, op: Json) => Effect.Effect<Json, PortFailure>;
	page: (
		instance: string,
		sync: string,
		partition: string,
		cursor: Json | null
	) => Effect.Effect<DriverPage, PortFailure>;
};
/** Observations of the kit's default file, deadline, transport and integration ports, plus AI requests and remaining responses when cassette playback is enabled. */
export type Fakes = {
	readonly audit: ReadonlyMap<string, AuditRecord>;
	/** `origin` is what `download` fetches: a URL's body, or a 404 for a URL it lacks. */
	readonly files: {
		readonly blobs: Map<string, Uint8Array>;
		readonly origin: Map<string, Uint8Array>;
	};
	readonly deadlines: { readonly announced: { scope: string; at: string }[] };
	readonly sent: TransportMessage[];
	readonly links: FakeLinks;
	/** The runtime log the kit's host holds: every event written, oldest first, `id` its position. */
	readonly logs: LogRow[];
	readonly ai?: {
		readonly requests: readonly AiRequest[];
		remaining(): { readonly [modelClass: string]: number };
	};
};
const RANK = { info: 0, warn: 1, error: 2 } as const;
/** The kit host's runtime log reader: a host store's page over `rows`, newest first (the tail reads forward). */
export const read_log_rows = (rows: readonly LogRow[], x: LogQuery): readonly LogRow[] => {
	const text = x.text?.toLowerCase();
	const kept = rows.filter(
		(r) =>
			(x.before === undefined || Number(r.id) < Number(x.before)) &&
			(x.after === undefined || Number(r.id) > Number(x.after)) &&
			(x.level === undefined || r.severity === x.level) &&
			(x.min === undefined || RANK[r.severity] >= RANK[x.min]) &&
			(text === undefined ||
				`${r.event} ${JSON.stringify(r.attributes)}`.toLowerCase().includes(text)) &&
			(x.conversation === undefined || r.conversation === x.conversation) &&
			(x.run === undefined || r.run === x.run) &&
			(x.automation === undefined ||
				JSON.stringify(r.attributes).includes(`"automation":${JSON.stringify(x.automation)}`)) &&
			(x.since === undefined || Date.parse(r.at) >= Date.parse(x.since)) &&
			(x.until === undefined || Date.parse(r.at) < Date.parse(x.until))
	);
	const limit = Math.min(Math.max(1, x.limit ?? 200), 200);
	return x.after === undefined
		? kept.toReversed().slice(0, limit)
		: kept.slice(0, limit).toReversed();
};
/** Host port service keys a test may replace with native Layers, including file storage, conversion, web, geography, transport, AI, outbound HTTP, images and MCP. */
export type TestPorts =
	| Logs
	| Files
	| Http
	| Images
	| Mcp
	| Convert
	| WebRead
	| Browser
	| Geo
	| Transport
	| DeadlinePort
	| Drivers
	| Ai;
/**
 * Workspace fixture and host configuration: use a verified release, check authored source, or supply a manifest/guest (with
 * `transforms`, the write callbacks it carries per verb: `'<model>.create'`, `'<model>.update'`); choose
 * seed data, control time, and native ports.
 */
export type TestOptions<P extends TestPorts = never> = {
	/** Default: the template's `test` pack when `root` has `seed/test/`, else none. Rows here replace it. */
	seed?: 'none' | SeedPack;
	pack?: Pack;
	now?: string;
	secrets_key?: Redacted.Redacted<Uint8Array>;
	/** The workspace guest CPU budget; the kit default is the host's 3000 ms. */
	guest_cpu_ms?: number;
	/** Optional meter for each guest run's CPU, for profiling a workspace. */
	guest_meter?: (session: string, nanos: bigint) => void;
	db?: Layer.Layer<TenantDb, KitFailure>;
	ports?: Layer.Layer<P, KitFailure>;
	fakes?: { ai?: CassetteOptions };
	links?: null;
	host?: Partial<ShellHostConfig> & {
		envoys?: ShapeOf<typeof EnvoyConfig>;
		agent?: ShapeOf<typeof AgentHost>;
	};
} & (
	| {
			/** A release verified by read_artifact; public HTTP requests execute its isolated server programs. */
			artifact: Artifact;
			root?: never;
			manifest?: never;
			guest?: never;
			transforms?: never;
	  }
	| {
			artifact?: never;
			root?: string;
			manifest?: EngineManifest;
			guest?: GuestProgram;
			transforms?: Iterable<string>;
	  }
);
/** A scoped workspace's test controls: create callers, inspect native rows and port observations, advance its clock, run due work, and exercise real HTTP and integration entry points. */
export type Kit = {
	readonly manifest: EngineManifest;
	/** The verified artifact hash, or the explicit in-memory test release. */
	readonly release: string;
	readonly db: TenantDbShape;
	/** A write callback's native stored reader (`ctx.query`), unscoped, in this workspace. */
	readonly stored_query: KitQuery;
	/** An automation's native batch writer, under this caller's authority. */
	body_acts(who: Holder | Authority): Effect.Effect<KitAct, BoltError>;
	readonly fakes: Fakes;
	/** Runs a remote sync read or drains committed writes through the workspace's real sync engine. */
	readonly syncs: {
		read(
			name: string,
			options?: { readonly instance?: string; readonly partition?: string }
		): Effect.Effect<{ readonly pages: number }, EngineError | KitInvalid>;
		deliver(): Effect.Effect<{ readonly delivered: number }, EngineError | KitInvalid>;
	};
	readonly count: { readonly reads: number; readonly writes: number; reset(): void };
	readonly clock: { now(): string; set(instant: string): void; advance(value: string): void };
	readonly admin: Holder;
	member(
		policies: readonly string[],
		over?: Partial<Extract<EngineActor, { kind: 'member' }>>
	): Holder & { readonly id: string };
	as(who: Holder | Authority): Effect.Effect<Caller, BoltError>;
	visitor(app: string, options?: { readonly ip?: string }): Effect.Effect<Caller, BoltError>;
	sign_in(address: string): Effect.Effect<Authority, KitFailure>;
	/**
	 * Fires crons due at the clock and drains every run due at it, chained runs included; dies if work stays due. Answers
	 * the runs that failed in this call, each with its own error.
	 */
	run_due(): Effect.Effect<{ readonly failed: readonly FailedRun[] }, EngineError>;
	/** The host dies as `runId` ends, before its end is recorded; the next boot requeues it to rerun from the start. */
	crash(runId: string): Effect.Effect<void, KitFailure>;
	/** Waits for background work to go quiet. It runs nothing queued: `run_due` runs model effects and started automations. */
	settled(): Effect.Effect<void>;
	receive(
		instance: string,
		messages: Json | readonly Json[],
		options?: { readonly history?: true; readonly bins?: readonly Uint8Array[] }
	): Effect.Effect<void, EngineError>;
	/** Real native HTTP routes, including isolated public SSR when acquired from an artifact. */
	handle(request: Request, options?: { readonly address?: string }): Effect.Effect<Response>;
	session(id: string): Effect.Effect<string, KitFailure>;
};
/** The engine, database, host, shell and port services made available alongside `TestWorkspace` by its layer. */
export type WorkspaceServices =
	| EngineServices
	| Crypto.Crypto
	| TenantDb
	| BoltHost
	| Files
	| Convert
	| WebRead
	| Browser
	| Geo
	| Transport
	| DeadlinePort
	| Drivers
	| Ai
	| Logs
	| Http
	| Images
	| Mcp
	| Keys
	| GuestIsolates
	| Docs
	| FileSystem.FileSystem
	| Path.Path
	| Activation
	| ShellConfig
	| HostIdentity
	| Turnstile
	| SessionAuthority;

const field = (o: unknown, key: string): unknown =>
	Predicate.hasProperty(o, key) ? o[key] : undefined;

const outcomes = ActReply.fields.outcome.pipe(Schema.toTaggedUnion('kind')).cases;
const jobHandle = Schema.Struct({ id: Schema.String, automation: Schema.String });
/** A queued automation's actual native receipt, suitable as a `run` result decoder. */
export const JobResult = Schema.Union([
	outcomes.pending_approval,
	Schema.Struct({ ...outcomes.committed.fields, output: jobHandle })
]);
export type JobResult = typeof JobResult.Type;
const rowState = {
	$label: Schema.optionalKey(Schema.NullOr(Schema.String)),
	$sync: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Struct({
			status: Schema.Literals(['pending', 'ok', 'failed']),
			message: Schema.optionalKey(Schema.String)
		}))
	),
	$approval: Schema.optionalKey(Schema.Struct({
		request_id: Schema.String,
		state: Schema.Literals(['Pending', 'ChangesRequested']),
		step: Schema.Number,
		steps: Schema.Array(Schema.Struct({ name: Schema.String, teams: Schema.Array(Schema.String), users: Schema.Array(Schema.String) })),
		requested_by: Schema.String
	}))
};
/** A native query row's fixed metadata; its manifest-dependent fields retain their decoded values. */
export const NativeReadRow = Schema.StructWithRest(
	Schema.Struct({ id: Schema.String, $distance: Schema.optionalKey(Schema.Number), ...rowState }),
	[Schema.Record(Schema.String, Schema.Unknown)]
);
export type NativeReadRow = typeof NativeReadRow.Type;

/** Native results use the host's catalogue and kind codecs. */
const nativeAnswers = (manifest: EngineManifest) => {
	const m = layered(manifest),
		cat = catalog(m);
	const absent = Schema.Null;
	const kind = (spec: Kind): Schema.Decoder<unknown> => output_schema(m, spec);
	const identity = (model: string) => {
		const info = cat.models.get(model);
		if (info === undefined) throw new KitInvalid({ message: `unknown model '${model}'` });
		return info.fields.get('id')?.pg === 'uuid'
			? input_schema({ kind: 'ref', to: model }).pipe(Schema.decodeTo(Schema.String))
			: Schema.String;
	};
	const computedKinds = {
		text: input_schema({ kind: 'text' }),
		int: input_schema({ kind: 'int' }),
		decimal: input_schema({ kind: 'money' }),
		money: input_schema({ kind: 'money' }),
		bool: input_schema({ kind: 'bool' }),
		date: input_schema({ kind: 'date' }),
		instant: input_schema({ kind: 'instant' })
	};
	/** A field's native codec on `model`: a ref's id (or arc), its declared kind, a computed value or a system column. */
	const fieldCodec = (model: string, name: string): Schema.Decoder<unknown> => {
		const spec = m.models[model];
		const relation = m.relationships[`${model}.${name}`];
		const declared = spec?.fields[name],
			computed = spec?.computed?.[name];
		if (relation !== undefined) {
			const codec =
				typeof relation.to === 'string'
					? identity(relation.to)
					: Schema.Union(
							relation.to.map((target) =>
								Schema.Struct({ model: Schema.Literal(target), id: identity(target) })
							)
						);
			return relation.optional ? Schema.NullOr(codec) : codec;
		}
		if (declared !== undefined) return kind(declared);
		if (computed !== undefined) {
			const value = computedKinds[computed.kind];
			return spec === undefined || nullable_of_expr(computed.expr, spec)
				? Schema.NullOr(value)
				: value;
		}
		if (name === 'revision') return Schema.Int;
		if (name === 'created_at' || name === 'updated_at') return input_schema({ kind: 'instant' });
		if (name === 'created_by' || name === 'updated_by') return Schema.NullOr(identity('sys_user'));
		throw new KitInvalid({ message: `unknown field '${model}.${name}'` });
	};
	const loose = Schema.optionalKey(Schema.Record(Schema.String, Schema.Json));
	const decimals = Schema.optionalKey(
		Schema.Record(Schema.String, Schema.NullOr(input_schema({ kind: 'money' })))
	);
	/** One aggregate row of a read request's root or many-layer: bucket `key`, `count` and the measures. */
	const aggRow = Schema.Struct({
		key: loose,
		count: Schema.optionalKey(Schema.Number),
		sum: decimals,
		avg: decimals,
		min: loose,
		max: loose
	});
	/**
	 * One row of read layer `path` under `root`: `id`, any field of the layer's model (the host picks the exposed or named
	 * ones), and each named sub-layer under its relation name in place of the FK (a ref: the row or `null`; a many-relation:
	 * its rows, or its aggregate). Root rows carry `$distance` (an index search) and the row state.
	 */
	/** Every column of `model` but `id`, each optional (the host picks which come: the output's fields or the named ones). */
	const anyColumns = (model: string) => {
		const names = new Set<string>([
			...SYSTEM_COLUMNS,
			...Object.keys(m.models[model]?.fields ?? {}),
			...Object.keys(m.models[model]?.computed ?? {}),
			...Object.keys(m.relationships)
				.filter((key) => key.startsWith(`${model}.`))
				.map((key) => key.slice(model.length + 1))
		]);
		names.delete('id');
		return Object.fromEntries(
			[...names].map((name): [string, Schema.optionalKey<Schema.Decoder<unknown>>] => {
				return [name, Schema.optionalKey(fieldCodec(model, name))];
			})
		);
	};
	/** A record's revisions (`history`), oldest first: each one's number, instant, actor, cause and changed fields. */
	const revisions = (model: string) =>
		Schema.Array(
			Schema.Struct({
				revision: Schema.Int,
				at: input_schema({ kind: 'instant' }).pipe(Schema.decodeTo(Schema.String)),
				actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String })),
				cause: Schema.Literals(['direct', 'cascade', 'derived', 'seed', 'erased']),
				changed: Schema.Struct(anyColumns(model))
			})
		);
	const requestRow = (
		root: string,
		path: string,
		named: ReadPlan[string]
	): Schema.Decoder<NativeReadRow> => {
		const model = layers(m)[root]?.[path];
		if (model === undefined)
			throw new KitInvalid({ message: `'${path}' is not a read layer ${root} declares` });
		const columns: Record<
			string,
			Schema.Decoder<unknown> | Schema.optionalKey<Schema.Decoder<unknown>>
		> = anyColumns(model);
		for (const [sub, layer] of Object.entries(named)) {
			const name = sub.slice(path.length + 1);
			if (!sub.startsWith(`${path}.`) || name.includes('.')) continue;
			columns[name] =
				layer.aggregate !== undefined
					? layer.aggregate.by === undefined
						? aggRow
						: Schema.Array(aggRow)
					: m.relationships[`${model}.${name}`] !== undefined
						? Schema.NullOr(requestRow(root, sub, named))
						: Schema.Array(requestRow(root, sub, named));
		}
		return Schema.Struct(
			path === root
				? { id: identity(model), ...columns, $distance: Schema.optionalKey(Schema.Number), ...rowState }
				: { id: identity(model), ...columns, $label: rowState.$label }
		);
	};
	/** A read request's answer: per root a page of layer rows, or its aggregate (a page of buckets with `by`). */
	const requestAnswer = (request: unknown) => {
		const plan = Result.match(
			Result.flatMap(decode_read_request(request), (json) => plan_read_request(json, m.exposures)),
			{
				onSuccess: (value) => value,
				onFailure: (message) => {
					throw new KitInvalid({ message });
				}
			}
		);
		return Schema.Struct(
			Object.fromEntries(
				Object.entries(plan).map(([root, named]) => {
					const aggregate = named[root]?.aggregate;
					return [
						root,
						aggregate === undefined
							? page(requestRow(root, root, named))
							: aggregate.by === undefined
								? aggRow
								: page(aggRow)
					] as const;
				})
			)
		);
	};
	const page = <A>(member: Schema.Decoder<A>) =>
		Schema.Struct({
			rows: Schema.Array(member),
			next: Schema.optionalKey(Schema.NullOr(Schema.String)),
			total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
		});
	const records = Schema.Array(
		Schema.Union(
			[...cat.exposures.keys()].map((model) =>
				Schema.Struct({
					model: Schema.Literal(model),
					id: identity(model),
					revision: Schema.Int
				})
			)
		)
	);
	const outputOf = (name: string) => {
		const dot = name.lastIndexOf('.'),
			model = name.slice(0, dot),
			callable = name.slice(dot + 1);
		return callable === 'import'
				? Schema.Struct({
						rows: Schema.Array(
							Schema.Struct({
								index: Schema.NullOr(Schema.Int),
								id: Schema.NullOr(identity(model)),
								action: Schema.Literals(['created', 'updated', 'kept', 'skipped', 'deleted'])
							})
						)
					})
				: absent;
	};
	const pendingApproval = Schema.Struct({
		...outcomes.pending_approval.fields,
		records
	});
	const startCodec =
		Schema.Union([
			pendingApproval,
			Schema.Struct({
				...outcomes.committed.fields,
				output: jobHandle,
				records
			})
		]);
	const mapCodec = (acts: ActMap) =>
		Schema.Union([
			pendingApproval,
			Schema.Struct({
				...outcomes.committed.fields,
				output: Schema.Struct(Object.fromEntries(Object.keys(acts).map((name) => [name, outputOf(name)]))),
				records
			})
		]);
	/** The returned value's type comes from its actual decoder. */
	const native = <A>(make: () => Schema.Decoder<A>, value: unknown) =>
		Effect.gen(function* () {
			const schema = yield* Effect.try({
				try: make,
				catch: (error) =>
					error instanceof KitInvalid
						? error
						: BoltError.make(
								'bad_answer',
								'decode',
								error instanceof Error ? error.message : String(error),
								error
							)
			});
			return yield* Schema.decodeUnknownEffect(schema)(value);
		});
	return {
		/** A read request's answer, per root, as native values (a runtime-built `ReadRequestJson`'s too). */
		read: (request: unknown, value: unknown) =>
			native(() => requestAnswer(request), value),
		history: (model: string, value: unknown) => native(() => revisions(model), value),
		run: (name: string, value: unknown) => Effect.gen(function* () {
			const automation = m.automations[name];
			if (automation?.mode !== 'call') return yield* native(() => startCodec, value);
			const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.Literal('committed'), output: Schema.Unknown }))(value);
			return yield* native(() => output_schema(m, automation.output), result.output);
		}),
		map: (value: unknown, input: ActMap) => native(() => mapCodec(input), value),
		queued: (value: unknown) => native(() => startCodec, value)
	};
};
const invalid = (e: unknown) =>
	new KitInvalid({ message: e instanceof Error ? e.message : String(e) });
/** Explicit fixture callbacks activate the same per-verb markers that compiled model declarations carry. */
function markedTransforms(manifest: EngineManifest, names: ReadonlySet<string>): EngineManifest {
	if (names.size === 0) return manifest;
	const exposures = { ...manifest.exposures };
	for (const name of names) {
		const dot = name.lastIndexOf('.'),
			model = name.slice(0, dot),
			verb = name.slice(dot + 1),
			spec = exposures[model];
		if (dot < 1 || (verb !== 'create' && verb !== 'update'))
			throw new KitInvalid({
				message: `TestWorkspace transform '${name}' must name '<model>.create' or '<model>.update'.`
			});
		if (spec === undefined)
			throw new KitInvalid({
				message: `TestWorkspace transform '${name}' has no declared write verb.`
			});
		if (verb === 'create') {
			if (spec.create === undefined)
				throw new KitInvalid({
					message: `TestWorkspace transform '${name}' has no declared write verb.`
				});
			exposures[model] = { ...spec, create: { ...spec.create, transform: true } };
		} else {
			if (spec.update === undefined)
				throw new KitInvalid({
					message: `TestWorkspace transform '${name}' has no declared write verb.`
				});
			exposures[model] = { ...spec, update: { ...spec.update, transform: true } };
		}
	}
	return { ...manifest, exposures };
}
const node = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
);
type CheckResult = import('../compiler/check/index.ts').CheckResult;
const compiled = new Map<string, Effect.Effect<CheckResult, KitInvalid>>();
// Keep the cache's existing permissive base64 decoder.
const CachedGuest = Schema.Struct({
	source: Schema.String,
	source_map: Schema.optionalKey(Schema.String),
	assets: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.String.pipe(
				Schema.decodeTo<typeof Schema.Uint8Array, typeof Schema.String>(Schema.Uint8Array, {
					decode: SchemaGetter.transform((text) => new Uint8Array(Buffer.from(text, 'base64'))),
					encode: SchemaGetter.transform((bytes) => Buffer.from(bytes).toString('base64'))
				})
			)
		)
	)
});
/** A check result as one run's processes share it: the guest's `?bytes` assets as base64, the manifest as its JSON. */
const RunChecked = Schema.Struct({
	stages: Schema.Array(
		Schema.Literals([
			'discover',
			'names',
			'bundle',
			'evaluate',
			'manifest',
			'seed',
			'schema',
			'rules'
		])
	),
	errors: Schema.Array(Diagnostic),
	manifest: Schema.optionalKey(Schema.Json),
	guest: Schema.optionalKey(CachedGuest),
	transforms: Schema.Array(Schema.String),
	seed: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json)))
	)
});
const toRun = (c: CheckResult): typeof RunChecked.Encoded => {
	const manifest: unknown =
		c.manifest === undefined ? undefined : JSON.parse(JSON.stringify(c.manifest));
	return {
		stages: c.stages,
		errors: c.errors,
		transforms: c.transforms,
		...(manifest === undefined
			? {}
			: { manifest: Schema.decodeUnknownSync(Schema.Json)(manifest) }),
		...(c.seed === undefined ? {} : { seed: c.seed }),
		...(c.guest === undefined ? {} : { guest: Schema.encodeSync(CachedGuest)(c.guest) })
	};
};
const fromRun = (r: typeof RunChecked.Type) =>
	Effect.gen(function* () {
		const manifest =
			r.manifest === undefined
				? undefined
				: yield* Effect.fromResult(decode_manifest(r.manifest)).pipe(Effect.mapError(invalid));
		const result: CheckResult = {
			stages: [...r.stages],
			errors: r.errors.map((e) => ({ ...e })),
			transforms: [...r.transforms],
			...(manifest === undefined ? {} : { manifest }),
			...(r.seed === undefined ? {} : { seed: r.seed }),
			...(r.guest === undefined ? {} : { guest: { ...r.guest } })
		};
		return result;
	});
/**
 * Checkpoints kept per kind on this machine: more than one run's workspaces (a whole realm run checks about 15), so a
 * run never evicts its own; a checked workspace is about 6 MiB.
 */
const KEPT_CHECKS = 64,
	KEPT_SEEDS = 128;
/** A workspace's checkpoint key: its source and the Bolt modules the checkpoint is built through. */
const sourceKey = (root: string, modules: Effect.Effect<string>) =>
	Effect.gen(function* () {
		return createHash('sha256')
			.update(`${yield* modules}\0${yield* tree_hash(root)}`)
			.digest('hex');
	}).pipe(Effect.mapError(invalid));
/** A workspace's check, from its checkpoint when its source and the compiler are unchanged, else checked once and kept. */
const storedCheck = (root: string, compute: Effect.Effect<CheckResult, KitInvalid>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = join(CHECKPOINTS, 'workspaces');
		const file = join(dir, `${yield* sourceKey(root, inputs.check)}.json`);
		const kept = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunChecked))),
				Effect.option
			);
		if (Option.isSome(kept)) return yield* fromRun(kept.value);
		return yield* Effect.tap(compute, (result) =>
			Effect.andThen(keep(file, JSON.stringify(toRun(result))), prune(dir, KEPT_CHECKS))
		);
	}).pipe(Effect.provide(node), Effect.mapError(invalid));
const checked = (root: string) =>
	Effect.gen(function* () {
		let cached = compiled.get(root);
		if (cached === undefined) {
			const compiler = yield* Effect.tryPromise({
				try: () => import('../compiler/check/index.ts'),
				catch: invalid
			});
			cached = yield* Effect.cached(
				storedCheck(
					root,
					compiler
						.check(root, { timing: false })
						.pipe(Effect.provide(node), Effect.mapError(invalid))
				)
			);
			compiled.set(root, cached);
		}
		return yield* cached;
	});
/** Check a workspace root and return its diagnostics, manifest and guest program; compiler loading and tool failures become `KitInvalid`. */
export const check = (root: string) => checked(root);
/** The template's `test` pack (`seed/test/`), built once per source beside its checkpoint; the first rename wins. */
const readTestPack = (root: string, manifest: EngineManifest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const shared = join(CHECKPOINTS, 'seeds', yield* sourceKey(root, inputs.seed));
		if (!(yield* fs.exists(join(shared, 'test', 'pack.json'))))
			yield* Effect.gen(function* () {
				const artifact = yield* Effect.tryPromise({
					try: () => import('../compiler/artifact/seed.ts'),
					catch: invalid
				});
				const errors: import('@norbital-ai/bolt/tooling').CheckDiagnostic[] = [];
				const temporary = `${shared}.${randomUUID()}`;
				yield* artifact.buildTestPack(root, manifest, temporary, errors);
				if (errors.length > 0)
					return yield* Effect.fail(
						new KitInvalid({
							message: `TestWorkspace: the test pack failed:\n${errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
						})
					);
				yield* fs.makeDirectory(dirname(shared), { recursive: true });
				yield* fs
					.rename(temporary, shared)
					.pipe(Effect.catch(() => fs.remove(temporary, { recursive: true, force: true })));
				yield* prune(dirname(shared), KEPT_SEEDS);
			});
		return yield* read_pack(join(shared, 'test'));
	}).pipe(Effect.provide(node), Effect.mapError(invalid));
const packs = new Map<string, Effect.Effect<Pack, KitInvalid>>();
/** The test pack, read once per process (hashing the source tree and decoding every row are not per-test work). */
const testPack = (root: string, manifest: EngineManifest) =>
	Effect.gen(function* () {
		let cached = packs.get(root);
		if (cached === undefined) {
			cached = yield* Effect.cached(readTestPack(root, manifest));
			packs.set(root, cached);
		}
		return yield* cached;
	});

/** A deterministic, zero-cost System 1 responder for tests: prefer the `respond` choice, otherwise the first choice, and return zero scores. */
export const respond_system_1: Ai['Service']['ask'] = (request) =>
	Effect.sync(() => ({
		cost_usd: 0,
		provider: 'test',
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => [
				id,
				question.type === 'noul'
					? { type: 'noul', noul: 0 }
					: question.type === 'choice'
						? {
								type: 'choice',
								choice: Object.hasOwn(question.criteria, 'respond')
									? 'respond'
									: (Object.keys(question.criteria)[0] ?? ''),
								confidence: 1,
								probabilities: {}
							}
						: { type: 'score', score: 0, level: 0, confidence: 1, probabilities: {}, legend: {} }
			])
		)
	}));
/** Schema-decoded cassettes as the intelligence group's `system1` and `system2`. */
export const cassette_ai = (options: CassetteOptions) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const turns = new Map<string, AiPortResponse[]>();
		for (const [modelClass, record] of Object.entries(options.cassette)) {
			const raw =
				typeof record === 'string'
					? (yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Schema.Struct({ turns: Schema.Array(Schema.Unknown) }))
						)(yield* fs.readFileString(record))).turns
					: record;
			const decoded: AiPortResponse[] = [];
			for (const [turn, value] of raw.entries())
				decoded.push(
					yield* Schema.decodeUnknownEffect(AiPortResponseSchema)(value).pipe(
						Effect.mapError(
							() =>
								new KitInvalid({
									message: `cassette: '${modelClass}' turn ${turn} is not an AiPortResponse`
								})
						)
					)
				);
			turns.set(modelClass, decoded);
		}
		const requests: AiRequest[] = [];
		const ask = options.sys_1 ?? respond_system_1;
		const system1: System1 = {
			ask: (request, signal) => Effect.runPromise(ask(request), { signal })
		};
		const system2: System2 = {
			models: [...turns.keys()],
			infer: async (request, _signal, onDelta) => {
				requests.push(request);
				const next = turns.get(request.model)?.shift();
				// an exhausted cassette is the fixture's own refusal, never a provider blip to wait out
				if (next === undefined)
					throw new FacilityFailure({
						kind: 'invalid',
						message: `cassette: '${request.model}' has no turn left (${requests.length} requests played)`
					});
				if (typeof next.content === 'string' && next.content !== '') onDelta?.(next.content);
				return next;
			}
		};
		return {
			requests,
			remaining: () => Object.fromEntries([...turns].map(([name, list]) => [name, list.length])),
			system1,
			system2
		};
	}).pipe(Effect.provide(node), Effect.mapError(invalid));

/** A durable in-process audit facility for a bare engine context; `TestWorkspace.layer` builds its own. */
export const memory_audit_layer: Layer.Layer<never> = Layer.unwrap(
	Effect.map(Effect.sync(memory_audit), (store) =>
		audit_from_abi(store.port).pipe(Layer.provide(NodeCrypto.layer))
	)
);

/** The transport ABI bodies the kit's host records as `fakes.sent`. */
const MailBody = Schema.Struct({
	to: Schema.String,
	subject: Schema.String,
	text: Schema.String,
	html: Schema.optionalKey(Schema.String),
	link: Schema.optionalKey(Schema.String)
});
const SmsBody = Schema.Struct({ to: Schema.String, text: Schema.String });
const PushBody = Schema.Struct({
	id: Schema.String,
	subscription: Schema.Struct({
		kind: Schema.Literals(['web', 'apns']),
		endpoint: Schema.String,
		keys: Schema.Json
	}),
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	path: Schema.String
});

/** A native test workspace service; its layer owns database and engine resources in scope and exposes the same host routes used by deployed workspaces. */
export class TestWorkspace extends Context.Service<TestWorkspace, Kit>()(
	'@norbital-ai/bolt-cli/test/TestWorkspace'
) {
	static readonly layer = <P extends TestPorts>(
		options: TestOptions<P>
	): Layer.Layer<TestWorkspace | WorkspaceServices, KitFailure> =>
		Layer.effectContext(
			Effect.gen(function* () {
				let { manifest, guest, transforms } = options;
				const artifact = options.artifact;
				let migrations = artifact?.migrations;
				if (artifact !== undefined) ({ manifest, guest } = artifact);
				// a template's tests seed from its own `test` pack (`seed/test/`) unless they pass rows or 'none'; the public
				// `base` and the bank's `sample` are product seeds, never test fixtures
				const seed = options.seed ?? 'none';
				const testRoot =
					options.seed === undefined &&
					options.root !== undefined &&
					(yield* FileSystem.FileSystem.pipe(
						Effect.flatMap((fs) => fs.exists(join(options.root ?? '', 'seed', 'test'))),
						Effect.provide(node),
						Effect.mapError(invalid)
					))
						? options.root
						: undefined;
				if (options.root !== undefined) {
					const built = yield* checked(options.root);
					if (built.errors.length > 0 || built.manifest === undefined)
						return yield* Effect.fail(
							new KitInvalid({
								message: `bolt check failed:\n${built.errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
							})
						);
					({ manifest, guest, transforms } = built);
					const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(node));
					const directory = join(options.root, 'migrations');
					if (yield* fs.exists(join(directory, 'snapshot.json')).pipe(Effect.mapError(invalid)))
						migrations = yield* read_migrations(directory).pipe(
							Effect.provide(node),
							Effect.mapError(invalid)
						);
				}
				if (manifest === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: 'TestWorkspace takes a root or a manifest' })
					);
				const sourceManifest = manifest,
					callbacks = new Set(transforms);
				const m = layered(
						yield* Effect.try({
							try: () => markedTransforms(sourceManifest, callbacks),
							catch: invalid
						})
					),
					count = {
						reads: 0,
						writes: 0,
						reset() {
							count.reads = 0;
							count.writes = 0;
						}
					};
				const dbContext = yield* Layer.build(options.db ?? TestDb.layer(m, migrations)),
					inner = Context.get(dbContext, TenantDb);
				const members = yield* Semaphore.make(1),
					pending: Sql[] = [];
				let crashing: string | null = null,
					crashed = false;
				const crashBoundary = (statements: readonly Sql[]) =>
					Effect.suspend(() => {
						const target = crashing;
						if (
							target === null ||
							!statements.some(
								(statement) =>
									/UPDATE sys_run s SET state = \$/.test(statement.text) &&
									JSON.stringify(statement.params).includes(target)
							)
						)
							return Effect.void;
						crashing = null;
						crashed = true;
						return Effect.fail(
							new DbError({
								message: 'crash: the host died before the run recorded its end',
								sqlstate: '08006'
							})
						);
					});
				const flush = Semaphore.withPermit(members)(
					Effect.gen(function* () {
						while (pending.length > 0) {
							const sql = pending[0];
							if (sql === undefined) break;
							yield* inner.write(sql);
							pending.shift();
						}
					})
				);
				const db = TenantDb.typed({
					read: (statements) =>
						Effect.gen(function* () {
							yield* flush;
							count.reads++;
							return yield* inner.read(statements);
						}),
					write: (statement, lock) =>
						Effect.gen(function* () {
							yield* flush;
							yield* crashBoundary([statement]);
							count.writes++;
							return yield* inner.write(statement, lock);
						}),
					// one act commits as one native batch: it counts as one write, as a single statement always has
					transaction: (batch) =>
						Effect.andThen(flush, crashBoundary(batch.statements)).pipe(
							Effect.andThen(Effect.sync(() => count.writes++)),
							Effect.andThen(inner.transaction(batch))
						)
				});
				let now = options.now ?? '2026-09-25T10:00:00.000Z';
				// the host's cron clock, stepped by `run_due`: a slot at or before this instant has had its turn
				let cronsThrough = Date.parse(now);
				const ranSlots = new Set<string>();
				const liveClock = Context.get(Context.empty(), Clock.Clock);
				// engine sleeps (debounce, wake and refresh timers) wait on this virtual time: `set`/`advance` wakes them, never the wall clock
				const sleepers = new Set<{ readonly at: number; readonly wake: () => void }>();
				// fibers a clock step woke that have not yet slept again or ended: `run_due` and `settled` wait for them, so work
				// a step made due (a debounce timer, a heartbeat) finishes before the host's own due work looks at the rows
				const woken = new Set<Fiber.Fiber<unknown, unknown>>(),
					observed = new WeakSet<Fiber.Fiber<unknown, unknown>>();
				const failedRuns = inner.rows(FailedRun, {
					text: `SELECT id::text AS id, automation, error->>'message' AS error FROM sys_run WHERE state = 'failed'`,
					params: []
				});
				const quiet = Effect.promise(async () => {
					while (woken.size > 0) await new Promise<void>((resolve) => setImmediate(resolve));
				});
				const wakeDue = () => {
					const at = Date.parse(now);
					for (const s of [...sleepers].toSorted((a, b) => a.at - b.at))
						if (s.at <= at) {
							sleepers.delete(s);
							s.wake();
						}
				};
				const clock: Clock.Clock = {
					monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
					monotonicTimeNanos: liveClock.monotonicTimeNanos,
					sleep: (duration) => {
						const ms = Duration.toMillis(duration);
						if (ms <= 0) return Effect.yieldNow;
						return Effect.withFiber((fiber) => {
							woken.delete(fiber);
							return Effect.callback<void>((resume) => {
								const sleeper = {
									at: Date.parse(now) + ms,
									wake: () => {
										woken.add(fiber);
										if (!observed.has(fiber)) {
											observed.add(fiber);
											fiber.addObserver(() => woken.delete(fiber));
										}
										resume(Effect.void);
									}
								};
								sleepers.add(sleeper);
								return Effect.sync(() => sleepers.delete(sleeper));
							});
						});
					},
					currentTimeMillisUnsafe: () => Date.parse(now),
					currentTimeMillis: Effect.sync(() => Date.parse(now)),
					currentTimeNanosUnsafe: () => BigInt(Date.parse(now)) * 1_000_000n,
					currentTimeNanos: Effect.sync(() => BigInt(Date.parse(now)) * 1_000_000n)
				};
				const auditStore = memory_audit();
				const f: Fakes = {
					audit: auditStore.records,
					files: { blobs: new Map(), origin: new Map() },
					deadlines: { announced: [] },
					sent: [],
					links: {
						sent: [],
						typed: [],
						answer: (instance) => Port.unavailable('link', `'${instance}' has no link`),
						page: (instance) => Port.unavailable('link', `'${instance}' has no link`)
					},
					logs: []
				};
				const overrides =
					options.ports === undefined ? undefined : yield* Layer.build(options.ports);
				if (
					options.fakes?.ai !== undefined &&
					overrides !== undefined &&
					Option.isSome(Context.getOption(overrides, Ai))
				)
					return yield* new KitInvalid({
						message: 'TestWorkspace: provide an Ai port or fakes.ai, not both'
					});
				const cassette =
					options.fakes?.ai === undefined ? undefined : yield* cassette_ai(options.fakes.ai);
				const fakes: Fakes = {
					...f,
					...(cassette === undefined
						? {}
						: { ai: { requests: cassette.requests, remaining: cassette.remaining } })
				};
				const {
					envoys: envoyConfig,
					agent: agentConfig,
					secure: hostSecure,
					...shellConfig
				} = options.host ?? {};
				const public_url = shellConfig.public_url ?? 'http://localhost';
				const secure = hostSecure ?? new URL(public_url).protocol === 'https:';
				const record = (message: TransportMessage) => {
					f.sent.push(message);
					return { provider_id: `${message._tag}:${f.sent.length}` };
				};
				const transport = (decode: (value: unknown) => TransportMessage): TransportPort => ({
					send: async (_kind, value) => record(decode(value))
				});
				const mail = transport((value) => ({ _tag: 'Mail', ...Schema.decodeUnknownSync(MailBody)(value) }));
				const sms = transport((value) => ({ _tag: 'Sms', ...Schema.decodeUnknownSync(SmsBody)(value) }));
				const push = transport((value) => ({ _tag: 'Push', ...Schema.decodeUnknownSync(PushBody)(value) }));
				const phone = logged_phone(() => {}, true);
				const files: FilesPort = {
					put: async (bytes, meta) => {
						const key = randomUUID();
						f.files.blobs.set(key, bytes);
						return {
							key,
							bytes: bytes.byteLength,
							sha256: createHash('sha256').update(bytes).digest('hex'),
							mime: meta.mime
						};
					},
					get: async (key, max) => {
						const bytes = f.files.blobs.get(key);
						if (bytes === undefined)
							throw new FacilityFailure({ kind: 'invalid', message: 'the file is not stored' });
						if (bytes.byteLength > max)
							throw new FacilityFailure({
								kind: 'invalid',
								message: `the file is over ${max} bytes`
							});
						return bytes;
					},
					url: async (key) => `memory://${key}`,
					remove: async (key) => {
						f.files.blobs.delete(key);
					},
					// the host's rule without the network: media by its first bytes, anything else refused
					download: async (url) => {
						const bytes = f.files.origin.get(url);
						if (bytes === undefined)
							throw new FacilityFailure({
								kind: 'upstream',
								message: 'The URL answered 404.',
								status: 404
							});
						const mime = media_type(bytes.subarray(0, DOWNLOAD.headBytes));
						if (mime === undefined)
							throw new FacilityFailure({
								kind: 'invalid',
								message:
									'The file is not media (an image, audio, video or a PDF); nothing was stored.'
							});
						const key = randomUUID();
						f.files.blobs.set(key, bytes);
						return {
							key,
							bytes: bytes.byteLength,
							sha256: createHash('sha256').update(bytes).digest('hex'),
							mime,
							name: url.split(/[?#]/)[0]?.split('/').at(-1) || 'download'
						};
					}
				};
				// a member the test scripts nothing for answers as an absent one does
				const scripted = (facility: string) =>
					Promise.reject({
						kind: 'unavailable',
						facility,
						reason: `the host provides no ${facility}`
					});
				// the kit is a host like any other: one `Facilities` record, its needs check, the shared ABI adapters
				const facilities: Facilities = {
					storage: { database: tenant_db_port(db), files },
					logs: {
						runtime: {
							write: (event) => {
								f.logs.push({ ...event, id: String(f.logs.length + 1) });
							},
							query: async (query) => read_log_rows(f.logs, query)
						},
						audit: auditStore.port
					},
					transactional: {
						mail,
						sms,
						phone,
						push: () => push,
						challenge: { site_key: 'dev', verify: async (token) => token === 'dev-pass' },
						fixed_codes: true
					},
					intelligence: {
						// the deterministic decision a cassette also starts from: a workspace with an `ai` block needs system1
						system1: cassette?.system1 ?? {
							ask: (request, signal) => Effect.runPromise(respond_system_1(request), { signal })
						},
						system2: cassette?.system2 ?? {
							models: [],
							infer: () => scripted('ai')
						},
						embed: { embed: () => scripted('ai.embed') }
					},
					ports: {
						webhooks: { public_url },
						websockets: off,
						outbound: {
							http: loopback_http_port,
							tcp: loopback_tcp_port
						}
					},
					sandbox: off,
					keys: keys_port(
						options.secrets_key === undefined ? randomBytes(32) : Redacted.value(options.secrets_key)
					)
				};
				const missing = unmet(m.needs, facilities);
				if (missing.length > 0)
					return yield* new KitInvalid({
						message: `TestWorkspace: the bundle needs ${missing.join(', ')}, which the test host leaves off`
					});
				const links =
					options.links === null
						? Drivers.fromAbi(off)
						: Layer.succeed(Drivers, {
								available: true,
								send: (instance, message, attachments) =>
									Effect.sync(() => {
										f.links.sent.push({
											instance,
											message,
											...(attachments === undefined ? {} : { attachments })
										});
										return { provider_id: `${instance}:${f.links.sent.length}` };
									}),
								typing: (instance, to, on) =>
									Effect.sync(() => {
										f.links.typed.push({ instance, to, on });
									}),
								unpaced: true,
								request: (instance, op) => f.links.answer(instance, op),
								read: (instance, sync, partition, cursor) =>
									f.links.page(instance, sync, partition, cursor),
								changed: () => Effect.void
							});
				const native = yield* node_ports(artifact === undefined ? {} : { release: artifact.dir });
				const ports = Layer.mergeAll(
					facility_layers(facilities),
					// the kit's own runner: guest code runs in this process's `node:vm` contexts
					GuestIsolates.fromAbi(
						node_guests({
							...(options.guest_cpu_ms == null ? {} : { cpu_ms: options.guest_cpu_ms }),
							...(options.guest_meter == null ? {} : { meter: options.guest_meter })
						})
					),
					links,
					Images.fromAbi(native.images),
					Docs.fromAbi(native.docs),
					Mcp.fromAbi(native.mcp),
					Convert.fromAbi(off),
					WebRead.fromAbi(off),
					Browser.fromAbi(off),
					Geo.fromAbi(off),
					Layer.succeed(DeadlinePort, {
						announce: (scope, at) =>
							Effect.sync(() => {
								f.deadlines.announced.push({ scope, at });
							}),
						settle: () => Effect.void,
						teardown: () => Effect.void
					})
				);
				const hostPorts =
					overrides === undefined ? ports : Layer.merge(ports, Layer.succeedContext(overrides));
				// Identity loads its keys from native tables, including on an injected database.
				if (options.db !== undefined) {
					const applied = yield* read_applied(db);
					if (applied === null || applied.fingerprint !== fingerprint(schema_slice(m))) {
						if (migrations === undefined) yield* TestDb.migrate(db, m, { accept: true });
						else yield* apply_migrations(db, m, migrations);
					}
				}
				const identityHost: IdentityHost = yield* make_identity_host({
					audit: yield* audit_shape(auditStore.port).pipe(Effect.provide(NodeCrypto.layer)),
					db,
					now: Effect.sync(() => new Date(now)),
					windows: new RateWindows(),
					keys: yield* load_keys(db),
					mail,
					sms,
					phone,
					dev_sink: true,
					public_url,
					...(signup_of(m) === undefined ? {} : { signup: signup_of(m) })
				}).pipe(Effect.provide(NodeCrypto.layer));
				const base = Layer.mergeAll(
					Layer.succeed(HostIdentity, identityHost),
					node,
					Layer.succeed(EnvoyConfig, envoyConfig ?? {}),
					Layer.effect(AgentHost, with_browser(agentConfig ?? {})).pipe(Layer.provide(hostPorts)),
					hostPorts,
					Layer.succeed(TenantDb, db),
					Layer.succeed(Clock.Clock, clock),
					Layer.succeed(Activation, {
						scope: 'test',
						epoch: '',
						release: artifact?.artifact.hash ?? 'test',
						public_url,
						guest: Option.fromNullishOr(guest)
					})
				);
				const pack =
					options.pack ?? (testRoot === undefined ? undefined : yield* testPack(testRoot, m));
				if (pack !== undefined) {
					const artifact = yield* Effect.tryPromise({
						try: () => import('@norbital-ai/bolt/artifact'),
						catch: invalid
					});
					const portContext = yield* Layer.build(hostPorts);
					yield* artifact
						.load_pack_with_assets(db, m, source_of(pack), Context.get(portContext, Files), now)
						.pipe(Effect.provide(node));
				} else if (typeof seed === 'object' && Object.keys(seed).length > 0) {
					if (IDENTITY.some((model) => seed[model] !== undefined)) {
						const pack: Pack = {
							dir: '',
							rows: seed,
							meta: {
								format: 1,
								name: 'test',
								hash: '',
								start: [],
								assets: [],
								rows: Object.fromEntries(
									Object.entries(seed).map(([name, rows]) => [name, rows.length])
								)
							}
						};
						yield* load_pack(db, m, source_of(pack), now);
					} else yield* restore(m, db, restore_source(seed), now);
				}
				const engineContext = yield* Layer.build(EngineLive(m).pipe(Layer.provideMerge(base)));
				const runs = Context.get(engineContext, Runs),
					live = Context.get(engineContext, Live),
					runHandlers = Context.get(engineContext, RunHandlers),
					envoys = Context.get(engineContext, Envoys),
					throttle = Context.get(engineContext, SmartThrottle),
					integration = Context.get(engineContext, Conversations);

				const shellBase = Layer.mergeAll(
					RateLimits.layer.pipe(Layer.provide(Layer.succeed(TenantDb, db))),
					Layer.succeed(ShellConfig, {
						public_url,
						workspace: () => ({ name: 'Test', handle: 'test' }),
						secure,
						...shellConfig
					}),
					Layer.succeedContext(engineContext)
				);
				// built once, as a host does: what it holds lives as long as the workspace
				const shellContext = yield* Layer.build(shellBase);
				const authorities = new Map<string, Authority>();
				const resolve = yield* session_authority.pipe(
					Effect.provide(shellContext),
					Effect.provideService(TenantDb, db)
				);
				const session = Layer.succeed(SessionAuthority, {
					of: (request) => {
						const authority = authorities.get(request.headers['bolt-test-authority'] ?? '');
						return authority === undefined
							? resolve(request).pipe(
									Effect.provide(shellContext),
									Effect.provideService(TenantDb, db)
								)
							: Effect.succeed(Option.some(authority));
					}
				});
				const hostContext = yield* Layer.build(
					BoltHostLive.pipe(
						Layer.provideMerge(session),
						Layer.provideMerge(ShellRoutes),
						Layer.provideMerge(Layer.succeedContext(shellContext))
					)
				);
				const host = Context.get(hostContext, BoltHost);
				const renderer =
					artifact === undefined
						? Option.none()
						: Option.some(
								Context.get(
									yield* Layer.build(
										public_pages(artifact).pipe(Layer.provide(Layer.succeedContext(hostContext)))
									).pipe(Effect.mapError(invalid)),
									PublicPages
								)
							);
				const handle: Kit['handle'] = (request, opts = {}) =>
					Effect.gen(function* () {
						const native = HttpServerRequest.fromWeb(request).modify({
							remoteAddress: Option.some(opts.address ?? '203.0.113.50')
						});
						const rendered = Option.isSome(renderer)
							? yield* renderer.value.render(native)
							: Option.none();
						return Option.isSome(rendered) ? rendered : yield* host.handle(native);
					}).pipe(
						Effect.map((response) =>
							Option.isSome(response)
								? HttpServerResponse.toWeb(response.value, { context: hostContext })
								: new Response(null, { status: 404 })
						),
						Effect.provide(hostContext)
					);
				const responseJson = (response: Response) =>
					Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: invalid });
				const answer = nativeAnswers(m);
				const storedReads = Context.get(engineContext, Reads),
					calls = Context.get(engineContext, Callables);
				const readFailure = (error: { readonly message: string }) =>
					error instanceof ReadFailed
						? error
						: new ReadFailed({
								code:
									error instanceof BoltError
										? error.code
										: error instanceof DbError
											? 'internal'
											: 'protocol',
								message: error.message
							});
				const decodeFailure = (error: unknown) =>
					error instanceof BoltError
						? error
						: BoltError.make(
								'invalid_input',
								'decode',
								error instanceof Error ? error.message : String(error),
								error
							);
				const wireJson = (value: unknown) =>
					Effect.try({ try: () => JSON.stringify(value), catch: decodeFailure }).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json)))
					);
				const decodeArgs = (args: readonly unknown[]) =>
					Effect.flatMap(wireJson(args), Schema.decodeUnknownEffect(Schema.Array(Schema.Json)));
				const stored_query: KitQuery = (request) => {
					const query = Effect.gen(function* () {
						const b = yield* bindings;
						// a read request crosses as its one argument, all roots in one crossing
						const args = yield* decodeArgs([request]);
						const ir = yield* lower_read(m, 'db.query', args);
						const value = (yield* storedReads.run([ir], { as: 'workspace' }, b))[0];
						if (value === undefined)
							return yield* Effect.fail(
								new ReadFailed({
									code: 'protocol',
									message: 'The host returned no stored read answer.'
								})
							);
						return yield* answer.read(request, value);
					});
					return query.pipe(Effect.mapError(readFailure), Effect.provide(hostContext));
				};
				const authorityOf = (who: Holder | Authority) =>
					'models' in who ? Effect.succeed(who) : compile_authority(m, who, `test:${randomUUID()}`);
				const body_acts: Kit['body_acts'] = (who) => Effect.map(authorityOf(who), (authority): KitAct =>
					<const A extends ActMap>(acts: KitActInput<A>, options: ActOptions = {}) => Effect.gen(function* () {
						const decoded = yield* wireJson(acts).pipe(
							Effect.flatMap((input) => decode_acts(m, input, options)),
							Effect.mapError((error) => new ActRefused({ code: error instanceof BoltError ? error.code : 'invalid_input', message: error.message }))
						);
						const b = yield* bindings;
						const key = options.key ?? randomUUID();
						const { outcome } = yield* calls.acts({
							name: 'act', acts: decoded.acts, outputs: decoded.outputs, key, issuedAt: b.now,
							authority, bindings: b, invocationId: key, from: 'Server'
						}).pipe(Effect.orDie);
						const failure = act_failure(outcome);
						if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
						return yield* answer.map(outcome, acts).pipe(Effect.orDie);
					}).pipe(Effect.provide(hostContext))
				);
				const caller = (authority: Authority, address = '203.0.113.7'): Caller => {
					const key = randomUUID();
					authorities.set(key, authority);
					const request = (path: string, body: unknown, headers: Record<string, string> = {}) =>
						handle(
							new Request(`http://localhost${path}`, {
								method: 'POST',
								headers: {
									'content-type': 'application/json',
									'bolt-test-authority': key,
									...headers
								},
								body: JSON.stringify(body)
							}),
							{ address }
						);
					const read = (member: string, args: readonly unknown[]) =>
						Effect.gen(function* () {
							const answer = yield* responseJson(
								yield* request(PATHS.q, { reads: [{ m: member, a: args }] })
							);
							const error = Schema.decodeUnknownOption(WireError)(answer);
							if (Option.isSome(error))
								return yield* Effect.fail(new ReadFailed(error.value.error));
							const reply = yield* Schema.decodeUnknownEffect(QReply)(answer).pipe(
								Effect.mapError((e) => new ReadFailed({ code: 'internal', message: e.message }))
							);
							const value = reply.answers[0];
							if (value === undefined)
								return yield* Effect.fail(
									new ReadFailed({ code: 'protocol', message: 'The host returned no read answer.' })
								);
							return value;
						}).pipe(
							Effect.mapError((e) =>
								e instanceof ReadFailed
									? e
									: new ReadFailed({ code: 'internal', message: e.message })
							)
						);
					const sendAct = (body: Readonly<Record<string, unknown>>, opts: ActOptions = {}, path: string = PATHS.act) =>
						Effect.gen(function* () {
							const { key } = opts;
							const id = key ?? randomUUID();
							const response = yield* request(
								path,
								{ ...body, issued_at: now },
								{ [HEADERS.key]: id }
							);
							const answer = yield* responseJson(response);
							const error = Schema.decodeUnknownOption(WireError)(answer);
							if (Option.isSome(error)) {
								const code = refusal_of_status(response.status);
								return yield* Effect.fail(
									code === null
										? new ActUnknown({ invocation: id })
										: new ActRefused({
												code: error.value.error.code,
												message: error.value.error.message
											})
								);
							}
							const reply = yield* Schema.decodeUnknownEffect(ActReply)(answer).pipe(Effect.orDie);
							const failure = act_failure(reply.outcome);
							if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
							// past the person-wait the write runs on as its run: `running` is an outcome, not a defect
							if (
								reply.outcome.kind === 'pending_approval' ||
								reply.outcome.kind === 'committed' ||
								reply.outcome.kind === 'running'
							)
								return reply.outcome;
							return yield* Effect.die(reply.outcome);
						}).pipe(Effect.catchTag('KitInvalid', Effect.die));
					const readError = (error: { readonly message: string }) =>
						new ReadFailed({ code: 'protocol', message: error.message });
					// a read request crosses as `{ m: 'query', a: [request] }`, as the page's and a body's do
					const callerQuery: KitQuery = (request) => {
						return read('query', [request]).pipe(
							Effect.flatMap((value) =>
								answer.read(request, value).pipe(Effect.mapError(readError))
							)
						);
					};
					// History crosses with its full options object, including the selected output.
					const history = <C extends string>(
						model: Is<C, ReadableName>,
						id: NoInfer<Id<C>>,
						options: HistoryOptions<C> = {}
					) => {
						return read('history', [model, id, options]).pipe(
							Effect.flatMap((value) =>
								answer.history(model, value).pipe(Effect.mapError(readError))
							)
						);
					};
					return {
						authority,
						query: callerQuery,
						history,
						act: <const A extends ActMap>(acts: KitActInput<A>, opts?: ActOptions) =>
							sendAct({ acts }, opts).pipe(Effect.flatMap((value) =>
								value.kind === 'running'
									? Effect.die(new Error(`A kit write was handed off to run ${value.run}.`))
									: answer.map(value, acts).pipe(Effect.orDie)
							)),
						run: <const A extends string, O>(
							name: Is<A, AutomationName>, input: NoInfer<StartInput<A>>, output: Schema.Decoder<O>, opts?: { id?: string }
						) => sendAct({ callable: 'run', input: {
							automation: name, input,
							...(m.automations[name]?.mode === 'call' ? {} : { id: opts?.id ?? uuidv7(Date.parse(now)) })
						} }).pipe(
							Effect.flatMap((value) => value.kind === 'running' ? Effect.die(value) : answer.run(name, value).pipe(Effect.orDie)),
							Effect.flatMap(Schema.decodeUnknownEffect(output))
						),
						sync_control: <const M extends string, const S extends string>(
							model: Is<M, ModelName>, sync: Is<S, FileSyncName<M> | ReadSyncName<M>>, input: NoInfer<SyncControlInput<M, S>>, opts?: { id?: string }
						) => {
							const id = opts?.id ?? uuidv7(Date.parse(now));
							return sendAct({ model, sync, id, input }, { key: id }, PATHS.sync_control).pipe(
								Effect.flatMap((value) => answer.queued(value).pipe(Effect.orDie))
							);
						},
						approvals: {
							decide: (request_id, input) =>
								sendAct({ callable: 'approvals.decide', input: { request_id, ...input } }).pipe(
									Effect.flatMap((value) =>
										value.kind === 'committed' ? Effect.void : Effect.die(value)
									)
								)
						},
						upload: (field, file) =>
							Effect.gen(function* () {
								const req = new Request(`http://localhost${PATHS.files}${field}`, {
									method: 'PUT',
									headers: {
										'content-type': file.mime,
										'bolt-test-authority': key,
										'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
										[HEADERS.key]: file.id ?? randomUUID()
									},
									body: new Uint8Array(file.bytes)
								});
								const answer = yield* responseJson(yield* handle(req, { address }));
								const error = Schema.decodeUnknownOption(WireError)(answer);
								if (Option.isSome(error))
									return yield* Effect.fail(new ActRefused(error.value.error));
								const output = yield* Schema.decodeUnknownEffect(
									Schema.Struct({
										id: Schema.String,
										name: Schema.String,
										mime: Schema.String,
										bytes: Schema.Number,
										sha256: Schema.String
									})
								)(answer).pipe(Effect.orDie);
								return {
									kind: 'committed' as const,
									output: { ...output, ...file_ref(output) },
									records: []
								};
							}).pipe(Effect.catchTag('KitInvalid', Effect.die))
					};
				};
				let admin: Holder | undefined;
				const member: Kit['member'] = (policies, over = {}) => {
					const actor: Extract<EngineActor, { kind: 'member' }> = {
						kind: 'member',
						id: randomUUID(),
						email: null,
						phone: null,
						external: false,
						teams: [],
						team_path: [],
						admin: false,
						party: null,
						...over
					};
					const team = actor.teams.find((name) => Object.hasOwn(m.teams, name)) ?? null;
					pending.push({
						text: 'INSERT INTO sys_user (id, email, phone, name, kind, admin, party, team) VALUES ($1,$2,$7,$3,$4,$5,$6::jsonb,$8) ON CONFLICT DO NOTHING',
						params: [
							actor.id,
							actor.email,
							actor.email ?? actor.phone ?? actor.id,
							actor.external ? 'external' : 'staff',
							actor.admin,
							actor.party === null ? null : JSON.stringify(actor.party),
							actor.phone,
							team
						]
					});
					return { actor, id: actor.id, policies, admin: actor.admin };
				};
				const syncRun = <A>(name: string, input: Json, codec: Schema.Decoder<A>) =>
					Effect.gen(function* () {
						const handler = yield* runHandlers.handler(name);
						if (Option.isNone(handler))
							return yield* Effect.fail(new KitInvalid({ message: `No sync handler '${name}'.` }));
						const value = yield* handler.value(input, { id: randomUUID(), starter: null });
						return yield* Schema.decodeUnknownEffect(codec)(value).pipe(Effect.mapError(invalid));
					}).pipe(Effect.provide(hostContext));
				const kit: Kit = {
					manifest: m,
					release: artifact?.artifact.hash ?? 'test',
					db,
					stored_query,
					body_acts,
					fakes,
					syncs: {
						read: (name, options = {}) =>
							syncs_of(m).get(name)?.read === true
								? syncRun(name, options, Schema.Struct({ pages: Schema.Int }))
								: Effect.fail(new KitInvalid({ message: `No remote read sync '${name}'.` })),
						deliver: () => syncRun(SYNC_DELIVER, {}, Schema.Struct({ delivered: Schema.Int }))
					},
					count,
					member,
					get admin() {
						return (admin ??= member([], { admin: true }));
					},
					clock: {
						now: () => now,
						set: (value) => {
							now = new Date(value).toISOString();
							// back in time the crons have those slots still ahead of them: a file's tests share one workspace
							cronsThrough = Math.min(cronsThrough, Date.parse(now) - 1);
							wakeDue();
						},
						advance: (value) => {
							now = new Date(Date.parse(now) + duration(value)).toISOString();
							wakeDue();
						}
					},
					as: (who) => Effect.map(authorityOf(who), (authority) => caller(authority)),
					visitor: (app, opts) =>
						Effect.map(new Authorities(m, 'test').visitor(app, randomUUID()), (authority) => caller(authority, opts?.ip)),
					sign_in: (address) =>
						Effect.gen(function* () {
							const addressParts = parse_address(address);
							if (addressParts === null)
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							const [result] = yield* db.read([
								{
									text: `SELECT id FROM sys_user WHERE ${member_column(addressParts, '$1')}`,
									params: [member_value(addressParts)]
								}
							]);
							const id = result?.rows[0]?.['id'];
							if (typeof id !== 'string')
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							const authority = yield* new Authorities(m, 'test').member(db, live.publish, id);
							if (authority === null)
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							return authority;
						}),
					run_due: () =>
						Effect.gen(function* () {
							yield* quiet;
							const failedBefore = new Set((yield* failedRuns).map((run) => run.id));
							const at = Date.parse(now);
							for (const entry of yield* runs.crons) {
								const cron = yield* Effect.orDie(
									Effect.fromResult(Cron.parse(entry.cron, entry.zone))
								);
								// the latest slot since the last step, once; slots skipped meanwhile are not replayed. `prev` is
								// strict at whole seconds (as the host's clock): one second past finds a slot at `at` itself
								const slot = Cron.prev(cron, at + 1000);
								if (slot.getTime() <= cronsThrough) continue;
								const key = `${entry.id} at ${slot.toISOString()}`;
								// a slot runs once, as on a host: a repeat would run and write nothing, without a word
								if (ranSlots.has(key))
									return yield* Effect.die(
										new KitInvalid({
											message: `run_due: ${key} already ran in this file, whose tests share one workspace: start this test's clock past it`
										})
									);
								if ((yield* runs.fire(entry.id, slot.toISOString())).ran) ranSlots.add(key);
							}
							cronsThrough = at;
							// chained work a run makes due at this instant runs in the same call: drain until nothing is due
							for (let pass = 1; ; pass++) {
								yield* runs.tick;
								yield* quiet;
								yield* throttle.settled;
								const [due] = yield* Effect.andThen(
									flush,
									inner.read([
										{
											text: `SELECT 1 FROM sys_run WHERE state = 'queued' AND due_at <= $1::timestamptz LIMIT 1`,
											params: [now]
										}
									])
								);
								if ((due?.rows.length ?? 0) === 0)
									return {
										failed: (yield* failedRuns).filter((run) => !failedBefore.has(run.id))
									};
								if (pass === DRAIN_PASSES)
									return yield* Effect.die(
										new KitInvalid({
											message: `run_due: work is still due at ${now} after ${DRAIN_PASSES} passes (a run requeues itself at the current instant)`
										})
									);
							}
						}).pipe(Effect.provide(hostContext)),
					crash: (runId) =>
						Effect.gen(function* () {
							crashing = runId;
							crashed = false;
							yield* runs.tick.pipe(Effect.catch((e) => (crashed ? Effect.void : Effect.fail(e))));
							crashing = null;
							if (!crashed)
								return yield* Effect.fail(
									new KitInvalid({ message: `run ${runId} did not run in this wake` })
								);
							yield* runs.boot();
						}).pipe(Effect.provide(hostContext)),
					settled: () =>
						Effect.andThen(
							quiet,
							Effect.andThen(throttle.settled, Effect.andThen(envoys.settled, host.settled))
						).pipe(Effect.provide(hostContext)),
					receive: (instance, messages, opts = {}) =>
						Effect.gen(function* () {
							yield* integration.receive(instance, {
								kind: 'messages',
								messages: Array.isArray(messages) ? messages : [messages],
								...opts
							});
							yield* runs.tick;
							yield* envoys.settled;
							yield* throttle.decided;
						}).pipe(Effect.provide(hostContext)),
					handle,
					session: (id) =>
						mint(identityHost, id).pipe(
							Effect.map((session) => `${cookie_names(secure).session}=${session.token}`),
							Effect.mapError(invalid)
						)
				};
				count.reset();
				return Context.add(hostContext, TestWorkspace, kit);
			})
		);
}
