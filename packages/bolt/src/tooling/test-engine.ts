// The test kit's engine: a whole workspace host (database, engine, identity, shell, HTTP routes and fake ports) assembled
// in one scoped Layer, so bolt-cli's kit names this one entry instead of the internals it is built from.
import { input_schema, type Kind } from '@norbital-ai/store/kind';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
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
	Redacted,
	Result,
	Schema,
	Semaphore
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ActInput, ActMap, ActOptions, Callable, Committed, HistoryOptions, PendingApproval, ReadRequest, ReadRequestBase, WriteTarget } from '../decl/ctx.ts';
import { ActRefused, ActUnknown, act_failure, type ActFailure } from '../decl/errors/act.ts';
import { FacilityFailure } from '../decl/errors/facility.ts';
import { ReadFailed } from '../decl/errors/read.ts';
import { nullable_of_expr } from '../decl/model.ts';
import type { AutomationName, FileSyncName, Is, ModelName, ReadSyncName, ReadableName } from '../decl/names.ts';
import type { StartInput } from '../decl/runtime/facilities.ts';
import type { AutomationSpecOf } from '../decl/runtime/names.ts';
import type { SyncControlInput } from '../decl/runtime/sync.ts';
import type { FileRef, Id, Json } from '../decl/values.ts';
import { compile_authority, type Holder } from '../engine/access/authority.ts';
import { RateWindows } from '../engine/access/rate.ts';
import { AgentHost } from '../engine/agent/index.ts';
import { with_browser } from '../engine/agent/browser.ts';
import { SmartThrottle } from '../engine/agent/throttle.ts';
import { AiPortResponseSchema } from '../engine/ai-schema.ts';
import { pack_asset_loader, type Artifact } from '../engine/artifact/read.ts';
import { audit_shape } from '../engine/audit.ts';
import { decode_acts } from '../engine/callables/index.ts';
import { output_schema } from '../engine/callables/output.ts';
import type {
	AiResponse,
	AiRequest,
	Authority,
	DriverEvent,
	DriverPage,
	EngineActor,
	FilesPort,
	GuestIsolatesPort,
	LogQuery,
	LogRow,
	Sql,
	TransportPort,
	AiPort
} from '../engine/contracts.ts';
import { TenantDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { EnvoyConfig } from '../engine/envoys/index.ts';
import { DbError, type EngineError } from '../engine/errors.ts';
import { DOWNLOAD, media_type } from '../engine/files/media.ts';
import type { GuestProgram } from '../engine/guest/runner.ts';
import { EngineLive, type EngineServices } from '../engine/host.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { member_column, member_value, parse_address } from '../engine/identity/address.ts';
import {
	load_keys,
	logged_phone,
	make_identity_host,
	mint,
	signup_of,
	type IdentityHost
} from '../engine/identity/session.ts';
import { layered, layers, type EngineManifest } from '../engine/manifest.ts';
import { Port, type PortFailure } from '../engine/port.ts';
import {
	Ai,
	Browser,
	Convert,
	Render,
	DeadlinePort,
	Docs,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Images,
	Keys,
	Logs,
	Mcp,
	Transport,
	WebRead,
	type TransportMessage
} from '../engine/ports.ts';
import { lower_read } from '../engine/query/engine.ts';
import { duration } from '../engine/runs/time.ts';
import {
	Activation,
	Callables,
	Conversations,
	Envoys,
	HostIdentity,
	Live,
	Reads,
	RunHandlers,
	Runs,
	type OutboundFile,
	type ShapeOf
} from '../engine/services.ts';
import { Syncs, syncs_of } from '../engine/sync/index.ts';
import { integration_links } from '../engine/integrations/links.ts';
import { credentials } from '../engine/integrations/credentials.ts';
import type { Provider } from '../engine/integrations/driver.ts';
import { Secrets } from '../engine/secrets.ts';
import type { SendRefused } from '../engine/conversations/status.ts';
import { SYNC_DELIVER } from '../engine/sync/outbox.ts';
import { IDENTITY, drain, load_pack, source_of, type Pack } from '../engine/write/pack.ts';
import { restore_source, seed as restore, type SeedPack } from '../engine/write/seed.ts';
import { off } from '../facilities/off.ts';
import { unmet } from '../facilities/needs.ts';
import type { Facilities } from '../facilities/index.ts';
import { keys_port } from '../node/keys.ts';
import { tenant_db_port } from '../node/db/port.ts';
import { loopback_http_port } from '../node/net.ts';
import { node_ports } from '../node/ports.ts';
import { loopback_tcp_port } from '../node/tcp.ts';
import { file_ref } from '../page/file-ref.ts';
import type { AuditPort, AuditRecord } from '../protocol/audit.ts';
import { catalog } from '../protocol/catalog.ts';
import { BoltError } from '../protocol/errors.ts';
import { facility_layers } from '../protocol/facility-layers.ts';
import { BoltHost, BoltHostLive } from '../protocol/host.ts';
import { RateLimits, SessionAuthority, bindings } from '../protocol/http.ts';
import { PublicPages, public_pages } from '../protocol/pages.ts';
import { decode_read_request, plan_read_request, type DynamicRead, type ReadPlan } from '../protocol/read-request.ts';
import { RowStateFields } from '../protocol/record-contracts.ts';
import { ActReply, QReply, WireError } from '../protocol/schema.ts';
import { HEADERS, PATHS, refusal_of_status, uuidv7 } from '../protocol/wire.ts';
import { cookie_names } from '../shell/nav.ts';
import {
	ShellConfig,
	ShellRoutes,
	Turnstile,
	session_authority,
	type ShellHostConfig
} from '../shell/host.ts';

/** The workspace's generated write callables, including model erase operations exercised by the test host. */
type KitCallable = Callable | `${ReadableName}.erase`;
/** A callable's native typed input; erase operations accept one or more model ids and an optional replacement set. */
type KitInput<N> = N extends `${infer C}.erase`
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
type NativeReadAnswer = Effect.Success<ReturnType<NativeAnswers['read']>>;
/** Actual revision images decoded against the running manifest, without an unrelated authored type claim. */
type NativeHistory = Effect.Success<ReturnType<NativeAnswers['history']>>;
/** A native map-write outcome, with each import result decoded using its actual model. */
type NativeActAnswer = Effect.Success<ReturnType<NativeAnswers['map']>>;
/** A native queued-job receipt, including the actual written records or held approval. */
type NativeJobAnswer = Effect.Success<ReturnType<NativeAnswers['queued']>>;
interface KitQuery {
	<const R extends ReadRequestBase>(request: ReadRequest<R> | DynamicRead): Effect.Effect<NativeReadAnswer, ReadFailed>;
}
type KitActInput<A extends ActMap> = A & (string extends keyof A
	? Readonly<Record<string, Json>>
	: { readonly [N in keyof A]: N extends KitCallable ? NoInfer<KitInput<N>> : never });
interface KitAct {
	<const A extends ActMap>(acts: KitActInput<A>, options?: ActOptions): Effect.Effect<NativeActAnswer, ActFailure>;
}
interface Caller {
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
type FailedRun = typeof FailedRun.Type;
/** `run_due` passes before it dies: a chain longer than this is a run requeueing itself at the same instant. */
const DRAIN_PASSES = 32;
/** Invalid test configuration, fixture input or compiler setup; these failures cannot be mistaken for a business refusal. */
export class KitInvalid extends Schema.TaggedError<KitInvalid>()('KitInvalid', {
	message: Schema.String
}) {}
/** Failures while acquiring or operating a test workspace: invalid fixtures, engine faults, port failures and platform I/O errors. */
type KitFailure = KitInvalid | EngineError | PortFailure | PlatformError;
/** Ordered AI responses per model class, supplied inline or by a JSON file containing a `turns` array. */
type Cassette = { readonly [modelClass: string]: readonly AiResponse[] | string };
/** AI playback configuration: response cassettes and an optional System 1 responder. */
type CassetteOptions = {
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
type FakeLinks = {
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
type Fakes = {
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
const read_log_rows = (rows: readonly LogRow[], x: LogQuery): readonly LogRow[] => {
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
type TestPorts =
	| Logs
	| Files
	| Http
	| Images
	| Mcp
	| Convert
	| Render
	| WebRead
	| Browser
	| Geo
	| Transport
	| DeadlinePort
	| Drivers
	| Ai;
/**
 * A resolved test workspace: the manifest and guest to run (the kit checks source or reads a release first), the database
 * it opens over the layered manifest, its guest runner and audit store, then seed data, time, host configuration and
 * native port overrides.
 */
type TestEngineOptions<P extends TestPorts> = {
	manifest: EngineManifest;
	guest?: GuestProgram | undefined;
	/** The write callbacks the guest carries per verb: `'<model>.create'`, `'<model>.update'`, `'<model>.delete'`. */
	transforms?: Iterable<string> | undefined;
	/** A release verified by read_artifact; public HTTP requests execute its isolated server programs. */
	artifact?: Artifact | undefined;
	db: (m: EngineManifest) => Layer.Layer<TenantDb, KitFailure>;
	guests: GuestIsolatesPort;
	/** The audit facility's store; `fakes.audit` reads its records. */
	audit: { readonly port: AuditPort; readonly records: ReadonlyMap<string, AuditRecord> };
	/** Rows loaded with their assets; without it, `seed`'s rows. */
	pack?: ((m: EngineManifest) => Effect.Effect<Pack, KitFailure>) | undefined;
	seed?: 'none' | SeedPack;
	now?: string;
	secrets_key?: Redacted.Redacted<Uint8Array>;
	ports?: Layer.Layer<P, KitFailure>;
	fakes?: { ai?: CassetteOptions };
	links?: null;
	/** The integration providers `integrations.pair` pairs an instance with (a test's fake provider). */
	providers?: readonly Provider[];
	host?: Partial<ShellHostConfig> & {
		envoys?: ShapeOf<typeof EnvoyConfig>;
		agent?: ShapeOf<typeof AgentHost>;
	};
};
/** A scoped workspace's test controls: create callers, inspect native rows and port observations, advance its clock, run due work, and exercise real HTTP and integration entry points. */
type Kit = {
	readonly manifest: EngineManifest;
	/** The verified artifact hash, or the explicit in-memory test release. */
	readonly release: string;
	readonly db: TenantDbShape;
	/** A write callback's native stored reader (`ctx.query`), unscoped, in this workspace. */
	readonly stored_query: KitQuery;
	/** An automation's native batch writer, under this caller's authority. */
	body_acts(who: Holder | Authority): Effect.Effect<KitAct, BoltError>;
	readonly fakes: Fakes;
	/**
	 * The workspace's real sync engine: `read` runs a remote sync's read, `deliver` drains committed writes, `write`
	 * commits one page of rows as `read` answers them (`$id`, `$version`, `$deleted` and fields) exactly as a read run
	 * commits a page, without the read body (`instance` defaults to the sync's one instance; a refused page fails with
	 * the act's failure), and `test` runs an instance's integration `test` body.
	 */
	readonly syncs: {
		read(
			name: string,
			options?: { readonly instance?: string; readonly partition?: string }
		): Effect.Effect<{ readonly pages: number }, EngineError | KitInvalid>;
		deliver(): Effect.Effect<{ readonly delivered: number }, EngineError | KitInvalid>;
		write(
			name: string,
			rows: readonly Json[],
			options?: { readonly instance?: string }
		): Effect.Effect<void, ActFailure | EngineError | KitInvalid>;
		test(instance: string): Effect.Effect<void, EngineError>;
	};
	/**
	 * The host's integration links over `providers`: `pair` pairs an instance as the settings page does (its provider
	 * writes the credential and status), `may` answers whether `who` may manage it (`null`: no such instance).
	 */
	readonly integrations: {
		pair(instance: string, input: Json): Effect.Effect<void, EngineError | PortFailure | SendRefused>;
		may(who: Holder | Authority, instance: string): Effect.Effect<boolean | null, EngineError | PortFailure | SendRefused>;
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
	/** Inbound conversation messages through the instance's link; a message the engine cannot decode fails the call. */
	receive(
		instance: string,
		messages: Json | readonly Json[],
		options?: { readonly history?: true; readonly bins?: readonly Uint8Array[] }
	): Effect.Effect<void, EngineError | KitInvalid>;
	/** Any other event a driver hands the engine: a delivery report, a cleared chat, presence, an outbound reference. */
	event(
		instance: string,
		event: Exclude<DriverEvent, { kind: 'messages' | 'invalidate' }>
	): Effect.Effect<void, EngineError>;
	/** Real native HTTP routes, including isolated public SSR when acquired from an artifact. */
	handle(request: Request, options?: { readonly address?: string }): Effect.Effect<Response>;
	session(id: string): Effect.Effect<string, KitFailure>;
};
/** The engine, database, host, shell and port services made available alongside `TestWorkspace` by its layer. */
type WorkspaceServices =
	| EngineServices
	| Crypto.Crypto
	| TenantDb
	| BoltHost
	| Files
	| Convert
	| Render
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

const outcomes = ActReply.fields.outcome.pipe(Schema.toTaggedUnion('kind')).cases;
const jobHandle = Schema.Struct({ id: Schema.String, automation: Schema.String });
/** A queued automation's actual native receipt, suitable as a `run` result decoder. */
const JobResult = Schema.Union([
	outcomes.pending_approval,
	Schema.Struct({ ...outcomes.committed.fields, output: jobHandle })
]);
/** A native query row's fixed metadata; its manifest-dependent fields retain their decoded values. */
const NativeReadRow = Schema.StructWithRest(
	Schema.Struct({ id: Schema.String, $distance: Schema.optionalKey(Schema.Number), ...RowStateFields }),
	[Schema.Record(Schema.String, Schema.Unknown)]
);
type NativeReadRow = typeof NativeReadRow.Type;

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
				? { id: identity(model), ...columns, $distance: Schema.optionalKey(Schema.Number), ...RowStateFields }
				: { id: identity(model), ...columns, $label: RowStateFields.$label }
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
		if (dot < 1 || (verb !== 'create' && verb !== 'update' && verb !== 'delete'))
			throw new KitInvalid({
				message: `TestWorkspace transform '${name}' must name '<model>.create', '<model>.update' or '<model>.delete'.`
			});
		const declared = spec?.[verb];
		if (spec === undefined || declared === undefined)
			throw new KitInvalid({
				message: `TestWorkspace transform '${name}' has no declared write verb.`
			});
		exposures[model] = { ...spec, [verb]: { ...declared, transform: true } };
	}
	return { ...manifest, exposures };
}
const node = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
);

/** A deterministic, zero-cost System 1 responder for tests: prefer the `respond` choice, otherwise the first choice, and return zero scores. */
const respond_system_1: Ai['Service']['ask'] = (request) =>
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
const cassette_ai = (options: CassetteOptions) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const turns = new Map<string, AiResponse[]>();
		for (const [modelClass, record] of Object.entries(options.cassette)) {
			const raw =
				typeof record === 'string'
					? (yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Schema.Struct({ turns: Schema.Array(Schema.Unknown) }))
						)(yield* fs.readFileString(record))).turns
					: record;
			const decoded: AiResponse[] = [];
			for (const [turn, value] of raw.entries())
				decoded.push(
					yield* Schema.decodeUnknownEffect(AiPortResponseSchema)(value).pipe(
						Effect.mapError(
							() =>
								new KitInvalid({
									message: `cassette: '${modelClass}' turn ${turn} is not an AiResponse`
								})
						)
					)
				);
			turns.set(modelClass, decoded);
		}
		const requests: AiRequest[] = [];
		const ask = options.sys_1 ?? respond_system_1;
		const system1: AiPort['sys_1'] = {
			ask: (request, signal) => Effect.runPromise(ask(request), { signal })
		};
		const system2: AiPort['sys_2'] = {
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

/** A test workspace's controls, as the layer from `test_engine` provides them; the kit's `TestWorkspace` is this service. */
export class TestEngine extends Context.Service<TestEngine, Kit>()('@norbital-ai/bolt/tooling/TestEngine') {
	/** A queued automation's actual native receipt, suitable as a `run` result decoder. */
	static readonly JobResult = JobResult;
	/** A native query row's fixed metadata; its manifest-dependent fields retain their decoded values. */
	static readonly NativeReadRow = NativeReadRow;
	/** A deterministic, zero-cost System 1 responder: the `respond` choice, else the first choice, and zero scores. */
	static readonly respond_system_1 = respond_system_1;
}

/**
 * A whole workspace host in scope: the database, engine, identity, shell and native HTTP routes over the kit's fake ports,
 * the same routes a deployed workspace serves. The kit's `TestWorkspace.layer` resolves a root or a release first.
 */
export const test_engine = <P extends TestPorts = never>(
	options: TestEngineOptions<P>
): Layer.Layer<TestEngine | WorkspaceServices, KitFailure> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const { artifact, guest } = options;
			const seed = options.seed ?? 'none';
			const callbacks = new Set(options.transforms);
			const m = layered(
					yield* Effect.try({
						try: () => markedTransforms(options.manifest, callbacks),
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
			const dbContext = yield* Layer.build(options.db(m)),
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
			const quiet = Effect.callback<void>((resume) => {
				const settle = () => (woken.size > 0 ? setImmediate(settle) : resume(Effect.void));
				settle();
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
			const auditStore = options.audit;
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
			const transport = (decode: (value: unknown) => Promise<TransportMessage>): TransportPort => ({
				send: async (_kind, value) => record(await decode(value))
			});
			const mail = transport(async (value) => ({ _tag: 'Mail', ...(await Schema.decodeUnknownPromise(MailBody)(value)) }));
			const sms = transport(async (value) => ({ _tag: 'Sms', ...(await Schema.decodeUnknownPromise(SmsBody)(value)) }));
			const push = transport(async (value) => ({ _tag: 'Push', ...(await Schema.decodeUnknownPromise(PushBody)(value)) }));
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
				GuestIsolates.fromAbi(options.guests),
				links,
				Images.fromAbi(native.images),
				Docs.fromAbi(native.docs),
				Mcp.fromAbi(native.mcp),
				Convert.fromAbi(off),
				Render.fromAbi(off),
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
			const pack = options.pack === undefined ? undefined : yield* options.pack(m);
			if (pack !== undefined) {
				const portContext = yield* Layer.build(hostPorts);
				yield* pack_asset_loader(db, m, source_of(pack), Context.get(portContext, Files), now).pipe(
					Effect.flatMap((loader) => drain(loader.step)),
					Effect.provide(node)
				);
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
				integration = Context.get(engineContext, Conversations),
				syncs = Context.get(engineContext, Syncs);

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
			const manager = yield* integration_links({
				providers: options.providers ?? [],
				enter: (work) => work.pipe(Effect.provide(hostContext)),
				admit: (work) => work.pipe(Effect.provide(hostContext)),
				credentials: yield* credentials(db, Context.get(engineContext, Secrets)).pipe(
					Effect.provide(NodeCrypto.layer)
				),
				public_url,
				tcp: loopback_tcp_port,
				log: () => {}
			}).pipe(Effect.provide(NodeCrypto.layer));
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
					deliver: () => syncRun(SYNC_DELIVER, {}, Schema.Struct({ delivered: Schema.Int })),
					write: (name, rows, options = {}) =>
						Effect.gen(function* () {
							const sync = syncs_of(m).get(name);
							if (sync?.read !== true)
								return yield* new KitInvalid({ message: `No remote read sync '${name}'.` });
							const [result] = yield* db.read([
								{ text: 'SELECT id FROM sys_integration WHERE integration = $1 ORDER BY id', params: [sync.definition] }
							]);
							const ids = (result?.rows ?? []).flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []));
							const instance = options.instance ?? (ids.length === 1 ? ids[0] : undefined);
							if (instance === undefined)
								return yield* new KitInvalid({
									message: `syncs.write: '${name}' has ${ids.length} instances; name one with { instance }`
								});
							yield* syncs.page(name, instance, rows).pipe(
								Effect.catch((error): Effect.Effect<never, ActFailure | EngineError> => {
									const failure = act_failure(error instanceof BoltError ? error.cause : undefined);
									return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.fail(error);
								})
							);
						}).pipe(Effect.provide(hostContext)),
					test: (instance) => syncs.test(instance).pipe(Effect.provide(hostContext))
				},
				integrations: {
					pair: (instance, input) => manager.pair(instance, input),
					may: (who, instance) =>
						Effect.flatMap(authorityOf(who), (authority) => manager.may(authority, instance))
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
						const logged = fakes.logs.length;
						yield* integration.receive(instance, {
							kind: 'messages',
							messages: Array.isArray(messages) ? messages : [messages],
							...opts
						});
						// the engine logs and acknowledges what does not decode (a link's bug); a test's input never is one
						const malformed = fakes.logs
							.slice(logged)
							.filter((row) => row.event === 'conversation.malformed');
						if (malformed.length > 0)
							return yield* new KitInvalid({
								message: `receive: ${malformed.length} message(s) did not decode as inbound messages (${malformed
									.map((row) => JSON.stringify(row.attributes))
									.join('; ')}); a delivery report or other driver event goes through event()`
							});
						yield* runs.tick;
						yield* envoys.settled;
						yield* throttle.decided;
					}).pipe(Effect.provide(hostContext)),
				event: (instance, event) =>
					Effect.gen(function* () {
						yield* integration.receive(instance, event);
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
			return Context.add(hostContext, TestEngine, kit);
		})
	);
