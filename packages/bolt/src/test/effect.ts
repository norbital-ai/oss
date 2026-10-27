// The workspace kit is a scoped Effect layer; its callers use the same routes as a real host.
import { inputSchema, type Fields, type Kind } from '@norbital-ai/std/kind';
import { auditFromAbi, auditShape } from '../engine/audit.ts';
import { memoryAudit } from './audit.ts';
import { Diagnostic } from '../protocol/diagnostic.ts';
import type { AuditRecord } from '../protocol/audit.ts';
import * as EffectVitest from '@effect/vitest';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
	Clock,
	Cache,
	Context,
	Cron,
	type Crypto,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	type Path,
	Option,
	Predicate,
	Redacted,
	Result,
	Schema,
	SchemaGetter,
	Semaphore,
	Stream
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileRef } from '../page/file-ref.ts';
import { BUILTIN_FIELDS } from '../decl/builtin-fields.ts';
import type { StartableName } from '../decl/access/policy.ts';
import type {
	Act,
	ActBatch,
	ActInput,
	ActManyInput,
	ActManyOutput,
	ActOutput,
	Callable,
	CallerQuery,
	Committed,
	Eff,
	PendingApproval,
	DynamicAnswer,
	HistoryOptions,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase,
	Revision,
	WorkspaceQuery
} from '../decl/ctx.ts';
import {
	type ActFailure,
	ActRefused,
	ActUnknown,
	actFailure,
	FacilityFailure,
	ReadFailed
} from '../decl/errors.ts';
import type { Is, ReadableName } from '../decl/names.ts';
import { nullableOfExpr } from '../decl/model.ts';
import type { RunHandle, StartInput } from '../decl/runtime/facilities.ts';
import type { FileRef, Id, Json } from '../decl/values.ts';
import { compileAuthority, type Holder } from '../engine/access/authority.ts';
import { isBatchCallable, parseCallable } from '../engine/callables/index.ts';
import { AgentHost } from '../engine/agent/index.ts';
import { withBrowser } from '../engine/agent/browser.ts';
import { DOWNLOAD, mediaType } from '../engine/files/media.ts';
import { EnvoyConfig } from '../engine/envoys/index.ts';
import { RateWindows } from '../engine/access/rate.ts';
import type {
	AiRequest,
	AiResponse,
	Authority,
	DriverPage,
	EngineActor,
	LogQuery,
	LogRow,
	Sql
} from '../engine/contracts.ts';
import { PgliteDb, Pristine } from '../node/db/pglite.ts';
import { nodePorts } from '../node/ports.ts';
import type { Artifact } from '../engine/artifact/read.ts';
import { TenantDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { DbError, type EngineError } from '../engine/errors.ts';
import { BoltError, storeSync } from '../protocol/errors.ts';
import { EngineLive, type EngineServices } from '../engine/host.ts';
import type { GuestProgram } from '../engine/guest/runner.ts';
import { memberColumn, memberValue, parseAddress } from '../engine/identity/address.ts';
import { Authorities } from '../engine/identity/actor.ts';
import {
	loadKeys,
	loggedPhone,
	makeIdentityHost,
	mint,
	signupOf,
	type IdentityHost
} from '../engine/identity/session.ts';
import { decodeManifest, layered, layers, type EngineManifest } from '../engine/manifest.ts';
import { Port, type PortFailure } from '../engine/port.ts';
import {
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
	Metering,
	Speech,
	Transport,
	WebRead,
	Browser,
	type AiEvent,
	type TransportMessage
} from '../engine/ports.ts';
import {
	applyPlan,
	plan,
	readApplied,
	schemaSlice,
	SchemaSliceSchema
} from '../engine/schema/plan.ts';
import { lowerRead } from '../engine/query/engine.ts';
import {
	Activation,
	Callables,
	Conversations,
	Envoys,
	Reads,
	RunHandlers,
	Runs,
	type ActsRequest,
	type OutboundFile,
	type ShapeOf
} from '../engine/services.ts';
import { duration } from '../engine/runs/time.ts';
import { syncsOf } from '../engine/sync/index.ts';
import { SYNC_DELIVER } from '../engine/sync/write.ts';
import { IDENTITY, loadPack, readPack, sourceOf, type Pack } from '../engine/write/pack.ts';
import { restoreSource, seed as restore, type SeedPack } from '../engine/write/seed.ts';
import { BoltHost, BoltHostLive } from '../protocol/host.ts';
import { PublicPages, publicPages } from '../protocol/pages.ts';
import { catalog } from '../protocol/catalog.ts';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import { bindings, RateLimits, SessionAuthority } from '../protocol/http.ts';
import {
	decodeReadRequest,
	planReadRequest,
	type ReadPlan,
	type ReadRequestJson
} from '../protocol/read-request.ts';
import { ActReply, QReply, WireError } from '../protocol/schema.ts';
import { HEADERS, PATHS, refusalOfStatus, uuidv7 } from '../protocol/wire.ts';
import {
	HostIdentity,
	ShellConfig,
	ShellRoutes,
	Turnstile,
	authorityOf,
	type ShellHostConfig
} from '../shell/host.ts';
import { cookieNames } from '../shell/nav.ts';

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
/** A test act's idempotency key and retry marker, conflict handling, and observed record revisions for concurrency checks. */
export type ActOptions = {
	key?: string;
	retry?: boolean;
	onConflict?: 'update' | 'keep';
	observed?: { readonly [id: string]: number };
};
/** The workspace's generated write callables, including model erase operations exercised by the test host. */
export type KitCallable = Callable | `${ReadableName}.erase`;
/** A callable's native typed input; erase operations accept one or more model ids and an optional replacement set. */
export type KitInput<N> = N extends `${infer C}.erase`
	? { target: Id<C> | readonly Id<C>[]; set?: Readonly<Record<string, Json>> }
	: ActInput<N>;
/**
 * Reads, writes, approval decisions, uploads and automation starts through the real host routes under one authority, with
 * native decoded values and typed failures. `query` is the one read API with the page's and `ctx.query`'s forms: a read
 * request (a layer map of roots and their declared layers, answered per root), a page of a model (`where`, `select`,
 * `orderBy`, a text or index `search`) or one record (`{ id }`, or `{ id, revision }`). Writes are batches: `act` takes a
 * verb's rows as an array; a policy `check` that denies fails with `ActRefused` (`rule`, `row`, `path`, `field`), one that
 * approves answers `pendingApproval`.
 */
export interface Caller {
	readonly authority: Authority;
	readonly query: CallerQuery<ReadFailed>['query'];
	/**
	 * A record's revisions as the page's `bolt.history` reads them, newest first; `at` starts from an instant, a revision
	 * or just before an approval request. A record as of a revision: take its `at`, then read the root with `asOf`.
	 */
	readonly history: CallerQuery<ReadFailed>['history'];
	act<const N extends string>(
		callable: Is<N, KitCallable>,
		input: NoInfer<KitInput<N>>,
		options?: ActOptions
	): Effect.Effect<Committed<ActOutput<N>, N> | PendingApproval<N>, ActFailure>;
	start<const A extends string>(
		automation: Is<A, StartableName>,
		input: NoInfer<StartInput<A>>,
		options?: { id?: string }
	): Effect.Effect<Committed<RunHandle<A>> | PendingApproval, ActFailure>;
	upload(
		field: `${string}.${string}`,
		file: { name: string; mime: string; bytes: Uint8Array; id?: string }
	): Effect.Effect<Committed<FileRef> | PendingApproval, ActFailure>;
	/** `bolt.approvals.decide`: approve, reject or request changes on a request this caller may decide now (a reason for the last two). */
	readonly approvals: {
		decide(
			requestId: string,
			input: { decision: 'approve' | 'reject' | 'requestChanges'; reason?: string }
		): Effect.Effect<void, ActFailure>;
	};
}
/** Invalid test configuration, fixture input or compiler setup; these failures cannot be mistaken for a business refusal. */
export class KitInvalid extends Schema.TaggedError<KitInvalid>()('KitInvalid', {
	message: Schema.String
}) {}
/** Failures while acquiring or operating a test workspace: invalid fixtures, engine faults, port failures and platform I/O errors. */
export type KitFailure = KitInvalid | EngineError | PortFailure | PlatformError;
/** Ordered AI responses per model class, supplied inline or by a JSON file containing a `turns` array. */
export type Cassette = { readonly [modelClass: string]: readonly AiResponse[] | string };
/** AI playback configuration: response cassettes, an optional System 1 responder, and a delay before each inference stream's first part. */
export type CassetteOptions = {
	cassette: Cassette;
	sys_1?: Ai['Service']['ask'];
	firstPartMs?: number;
};
/**
 * The default integration driver fake, a test's remote system: inspect sent messages and typing notices; `answer` is the
 * remote a sync's `read` and `write` reach through `ctx.request` (a request driver's call: list pages, write acks,
 * refusals), and `page` a pushing driver's page of items for a sync (`read`'s `items`, a calendar's events).
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
export const readLogRows = (rows: readonly LogRow[], x: LogQuery): readonly LogRow[] => {
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
/** Host port service keys a test may replace with native Layers, including file storage, conversion, speech, web, geography, transport, AI, outbound HTTP, images and MCP. */
export type TestPorts =
	| Files
	| Http
	| Images
	| Mcp
	| Convert
	| Speech
	| WebRead
	| Browser
	| Geo
	| Metering
	| Transport
	| DeadlinePort
	| Drivers
	| Ai;
/**
 * Workspace fixture and host configuration: use a verified release, check authored source, or supply a manifest/guest (with
 * `transforms`, the write callbacks it carries per verb: `'<model>.create'`, `'<model>.update'`, `'<model>.delete'`); choose
 * seed data, control time, and native ports.
 */
export type TestOptions<P extends TestPorts = never> = {
	seed?: 'base' | 'sample' | 'none' | SeedPack;
	pack?: Pack;
	now?: string;
	secretsKey?: Redacted.Redacted<Uint8Array>;
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
			/** A release verified by readArtifact; public HTTP requests execute its isolated server programs. */
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
	/** A write callback's native, unmasked stored reader (`ctx.db.query`), scoped to this workspace. */
	readonly storedQuery: WorkspaceQuery['query'];
	/** An automation's native batch writer, under this caller's authority. */
	bodyActs(who: Holder | Authority): Pick<Act, 'many' | 'checked'>;
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
	as(who: Holder | Authority): Caller;
	visitor(app: string, options?: { readonly ip?: string }): Caller;
	signIn(address: string): Effect.Effect<Authority, KitFailure>;
	runDue(): Effect.Effect<void, EngineError>;
	crash(runId: string): Effect.Effect<void, KitFailure>;
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
	| Speech
	| WebRead
	| Browser
	| Geo
	| Metering
	| Transport
	| DeadlinePort
	| Drivers
	| Ai
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

/** Native results use the host's catalogue and kind codecs; only caller values admit masks. */
const nativeAnswers = (manifest: EngineManifest, readAs: 'caller' | 'workspace' = 'caller') => {
	const m = layered(manifest),
		cat = catalog(m);
	const absent = Schema.Null;
	const fields = (spec: Fields) =>
		Schema.Struct(
			Object.fromEntries(
				Object.entries(spec).map(
					([name, member]): [
						string,
						Schema.Decoder<unknown> | Schema.optionalKey<Schema.Decoder<unknown>>
					] => [
						name,
						member.optional === true || member.default !== undefined
							? Schema.optionalKey(kind(member))
							: kind(member)
					]
				)
			)
		);
	const kind = (spec: Kind): Schema.Decoder<unknown> => {
		let codec: Schema.Decoder<unknown>;
		switch (spec.kind) {
			case 'custom': {
				const shape =
					m.customFields[spec.of]?.shape ??
					Object.entries(BUILTIN_FIELDS).find(([name]) => name === spec.of)?.[1].spec.shape;
				if (shape === undefined)
					throw new KitInvalid({ message: `unknown custom field '${spec.of}'` });
				codec = kind(shape);
				if (spec.many) codec = Schema.Array(codec);
				break;
			}
			case 'json':
				codec = spec.shape === undefined ? Schema.Json : kind(spec.shape);
				break;
			case 'list':
				codec = Schema.Array(kind(spec.of));
				break;
			case 'record':
				codec = Schema.Record(Schema.String, kind(spec.of));
				break;
			case 'object': {
				const named = fields(spec.fields);
				const extra = Schema.String.check(
					Schema.makeFilter((key: string) => !Object.hasOwn(spec.fields, key))
				);
				codec =
					spec.rest === undefined
						? named
						: Schema.StructWithRest(named, [Schema.Record(extra, kind(spec.rest))]);
				break;
			}
			case 'union':
				codec =
					'of' in spec
						? Schema.Union(spec.of.map(kind))
						: Schema.Union(
								Object.entries(spec.arms).map(([tag, arm]) =>
									Schema.Struct({
										...fields(arm).fields,
										[spec.by]: Schema.Literal(tag)
									})
								)
							);
				break;
			default:
				return inputSchema(spec);
		}
		return spec.optional === true ? Schema.NullOr(codec) : codec;
	};
	const identity = (model: string) => {
		const info = cat.models.get(model);
		if (info === undefined) throw new KitInvalid({ message: `unknown model '${model}'` });
		return info.fields.get('id')?.pg === 'uuid'
			? inputSchema({ kind: 'id', of: model })
			: Schema.String;
	};
	const masked = Schema.Struct({ $masked: Schema.Literal(true) });
	const computedKinds = {
		text: inputSchema({ kind: 'text' }),
		int: inputSchema({ kind: 'int' }),
		decimal: inputSchema({ kind: 'money' }),
		money: inputSchema({ kind: 'money' }),
		bool: inputSchema({ kind: 'bool' }),
		date: inputSchema({ kind: 'date' }),
		instant: inputSchema({ kind: 'instant' })
	};
	const strings = Schema.Array(Schema.String);
	const grantFields = Schema.Struct({
		read: Schema.optionalKey(Schema.Unknown),
		fields: Schema.optionalKey(Schema.Union([Schema.Literal('all'), strings]))
	});
	/**
	 * Whether a caller may see `field` of read layer `path` masked: some policy's grant on the root narrows that layer's
	 * `fields` (an identity grant's `fields` sit beside its bare `Where`). A layer a grant does not name is read in full.
	 */
	const maskable = (root: string, path: string, name: string) =>
		!SYSTEM_COLUMNS.some((column) => column === name) &&
		Object.values(m.policies).some((policy) => {
			const grant = Schema.decodeUnknownOption(grantFields)(policy.grants[root]);
			if (Option.isNone(grant)) return false;
			const read = grant.value.read;
			if (read === undefined || read === true) return false;
			const layered =
				Predicate.isObject(read) &&
				Object.keys(read).some((key) => key === root || key.startsWith(`${root}.`));
			const admitted = Schema.decodeUnknownOption(strings)(
				layered ? field(field(read, path), 'fields') : path === root ? grant.value.fields : undefined
			);
			return Option.isSome(admitted) && !admitted.value.includes(name);
		});
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
			return spec === undefined || nullableOfExpr(computed.expr, spec)
				? Schema.NullOr(value)
				: value;
		}
		if (name === 'revision') return Schema.Int;
		if (name === 'created_at' || name === 'updated_at') return inputSchema({ kind: 'instant' });
		if (name === 'created_by' || name === 'updated_by') return Schema.NullOr(identity('sys_user'));
		throw new KitInvalid({ message: `unknown field '${model}.${name}'` });
	};
	const rowState = {
		$sync: Schema.optionalKey(
				Schema.Record(
					Schema.String,
					Schema.Struct({
						status: Schema.Literals(['pending', 'ok', 'failed']),
						message: Schema.optionalKey(Schema.String)
					})
				)
			),
			$approval: Schema.optionalKey(
				Schema.Struct({
					requestId: Schema.String,
					state: Schema.Literals(['Pending', 'ChangesRequested']),
					step: Schema.Number,
					steps: Schema.Array(
						Schema.Struct({
							name: Schema.String,
							teams: Schema.Array(Schema.String),
							users: Schema.Array(Schema.String)
						})
					),
					requestedBy: Schema.String
				})
			)
	};
	const loose = Schema.optionalKey(Schema.Record(Schema.String, Schema.Json));
	const decimals = Schema.optionalKey(
		Schema.Record(Schema.String, Schema.NullOr(inputSchema({ kind: 'money' })))
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
	/** Every column of `model` but `id`, each optional (the host picks which come), masked where a root policy masks `path`. */
	const anyColumns = (root: string, path: string, model: string) => {
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
				const codec = fieldCodec(model, name);
				return [
					name,
					Schema.optionalKey(
						readAs === 'caller' && maskable(root, path, name)
							? Schema.Union([codec, masked])
							: codec
					)
				];
			})
		);
	};
	/** A record's revisions (`history`), newest first: each one's number, instant, actor, cause and changed fields. */
	const revisions = (model: string) =>
		Schema.Array(
			Schema.Struct({
				revision: Schema.Int,
				at: inputSchema({ kind: 'instant' }),
				actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String })),
				cause: Schema.Literals(['direct', 'cascade', 'derived', 'seed', 'erased']),
				changed: Schema.Struct(anyColumns(model, model, model))
			})
		);
	const requestRow = (
		root: string,
		path: string,
		named: ReadPlan[string]
	): Schema.Decoder<unknown> => {
		const model = layers(m)[root]?.[path];
		if (model === undefined)
			throw new KitInvalid({ message: `'${path}' is not a read layer ${root} declares` });
		const columns: Record<string, Schema.Decoder<unknown> | Schema.optionalKey<Schema.Decoder<unknown>>> =
			{ id: identity(model), ...anyColumns(root, path, model) };
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
				? { ...columns, $distance: Schema.optionalKey(Schema.Number), ...rowState }
				: columns
		);
	};
	/** A read request's answer: per root a page of layer rows, or its aggregate (a page of buckets with `by`). */
	const requestAnswer = (request: unknown): Schema.Decoder<unknown> => {
		const plan = Result.match(
			Result.flatMap(decodeReadRequest(request), (json) => planReadRequest(json, m.exposures)),
			{
				onSuccess: (value) => value,
				onFailure: (message) => {
					throw new KitInvalid({ message });
				}
			}
		);
		return Schema.Struct(
			Object.fromEntries(
				Object.entries(plan).map(([root, named]): [string, Schema.Decoder<unknown>] => {
					const aggregate = named[root]?.aggregate;
					return [
						root,
						aggregate === undefined
							? page(requestRow(root, root, named))
							: aggregate.by === undefined
								? aggRow
								: page(aggRow)
					];
				})
			)
		);
	};
	const page = (member: Schema.Decoder<unknown>) =>
		Schema.Struct({
			rows: Schema.Array(member),
			next: Schema.optionalKey(Schema.NullOr(Schema.String))
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
	const outputOf = (method: 'act' | 'start', name: string): Schema.Decoder<unknown> => {
		const dot = name.lastIndexOf('.'),
			model = name.slice(0, dot),
			callable = name.slice(dot + 1);
		return method === 'start'
			? Schema.Struct({ id: identity('sys_run'), automation: Schema.String })
			: callable === 'upsert'
				? Schema.Array(Schema.NullOr(identity(model)))
				: callable === 'import'
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
	const actCodec = (method: 'act' | 'start', name: string) =>
		Schema.Union([
			Schema.Struct({ kind: Schema.Literal('pendingApproval'), requestId: Schema.String, records }),
			Schema.Struct({
				kind: Schema.Literal('committed'),
				output: outputOf(method, name),
				records
			})
		]);
	const manyCodec = (acts: ActBatch) =>
		Schema.Union([
			Schema.Struct({ kind: Schema.Literal('pendingApproval'), requestId: Schema.String, records }),
			Schema.Struct({
				kind: Schema.Literal('committed'),
				output: Schema.Tuple(acts.map((act) => outputOf('act', act.callable))),
				records
			})
		]);
	/** Decodes `value` with the codec `make` builds, then claims the native type `T` it proved. */
	const native = <T>(make: () => Schema.Decoder<unknown>, value: unknown) =>
		Effect.gen(function* () {
			const schema = yield* Effect.try({
				try: make,
				catch: (error) =>
					error instanceof KitInvalid
						? error
						: BoltError.make(
								'badAnswer',
								'decode',
								error instanceof Error ? error.message : String(error),
								error
							)
			});
			const decoded = yield* Schema.decodeUnknownEffect(schema)(value);
			// This is the sole static brand boundary: the exact native schema decoded and revived every claimed value above.
			const branded = Schema.declare((answer: unknown): answer is T =>
				Schema.is(Schema.toType(schema))(answer)
			);
			return yield* Schema.decodeUnknownEffect(branded)(decoded);
		});
	return {
		/** A read request's answer, per root, as native values (a runtime-built `ReadRequestJson`'s too). */
		read: (request: unknown, value: unknown) => native<unknown>(() => requestAnswer(request), value),
		history: (model: string, value: unknown) => native<unknown>(() => revisions(model), value),
		act: <N extends string>(name: Is<N, KitCallable>, value: unknown) =>
			native<Committed<ActOutput<N>, N> | PendingApproval<N>>(() => actCodec('act', name), value),
		start: <A extends string>(value: unknown) =>
			native<Committed<RunHandle<A>> | PendingApproval>(() => actCodec('start', ''), value),
		many: <const A extends ActBatch>(value: unknown, input: A) =>
			native<
				Committed<ActManyOutput<A>, A[number]['callable']> | PendingApproval<A[number]['callable']>
			>(() => manyCodec(input), value),
		checked: (value: unknown) =>
			native<Effect.Success<ReturnType<Act['checked']>>>(
				() =>
					Schema.Union([
						Schema.Struct({
							kind: Schema.Literal('pendingApproval'),
							requestId: Schema.String,
							records
						}),
						Schema.Struct({
							kind: Schema.Literal('committed'),
							output: Schema.Array(Schema.Json),
							records
						})
					]),
				value
			)
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
		} else if (verb === 'update') {
			if (spec.update === undefined)
				throw new KitInvalid({
					message: `TestWorkspace transform '${name}' has no declared write verb.`
				});
			exposures[model] = { ...spec, update: { ...spec.update, transform: true } };
		} else {
			if (spec.delete === undefined)
				throw new KitInvalid({
					message: `TestWorkspace transform '${name}' has no declared write verb.`
				});
			exposures[model] = { ...spec, delete: { ...spec.delete, check: true } };
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
	sourceMap: Schema.optionalKey(Schema.String),
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
				: yield* Effect.fromResult(decodeManifest(r.manifest)).pipe(Effect.mapError(invalid));
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
 * Each test file runs in a fresh process; `bolt test` hands its processes one directory for the run
 * (`BOLT_TEST_RUN_CACHE`), so the workspace is checked once per run, not once per file. It is made fresh each run, so a
 * result never outlives the source or the Bolt it came from.
 */
const runChecked = (root: string, compute: Effect.Effect<CheckResult, KitInvalid>) =>
	Effect.gen(function* () {
		const dir = process.env['BOLT_TEST_RUN_CACHE'];
		if (dir === undefined || dir === '') return yield* compute;
		const fs = yield* FileSystem.FileSystem;
		const file = join(dir, `${createHash('sha256').update(root).digest('hex')}.json`);
		const kept = yield* fs.readFileString(file).pipe(Effect.option);
		if (Option.isSome(kept))
			return yield* fromRun(
				yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunChecked))(kept.value).pipe(
					Effect.mapError(invalid)
				)
			);
		const result = yield* compute;
		// written whole, then renamed: a parallel test process never reads half a result
		const temporary = `${file}.${randomUUID()}`;
		yield* fs.writeFileString(temporary, JSON.stringify(toRun(result)));
		yield* fs.rename(temporary, file);
		return result;
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
				runChecked(root, compiler.check(root).pipe(Effect.provide(node), Effect.mapError(invalid)))
			);
			compiled.set(root, cached);
		}
		return yield* cached;
	});
/** Check a workspace root and return its diagnostics, manifest and guest program; compiler loading and tool failures become `KitInvalid`. */
export const check = (root: string) => checked(root);
// Only unseeded images are shared. Every workspace owns its database and loads its own seed.
type SchemaImageFailure = BoltError | DbError | KitInvalid;
/** The schema image's key: its slice, and the workspace whose `.norbital/cache` keeps it across test processes. */
const ImageKey = Schema.Struct({ dir: Schema.NullOr(Schema.String), slice: SchemaSliceSchema });
/** The PGlite build (its versioned store path): an image from another build is another key. */
// `createRequire`, not `import.meta.resolve`: a template's vitest module runner supports only the former
const PGLITE = createRequire(import.meta.url).resolve('@electric-sql/pglite');
const KEPT_IMAGES = 4;
/** initdb (~2 s, ~0.8 GB) and the plan (~1 s) for one schema; each test file runs in a fresh process. */
const freshImage = (slice: typeof SchemaSliceSchema.Type) =>
	Effect.scoped(
		Effect.gen(function* () {
			const pg = yield* PgliteDb.open().pipe(Effect.provide(Pristine.layer));
			const db = PgliteDb.make(pg);
			yield* applyPlan(db, yield* plan(yield* readApplied(db), slice), { accept: true });
			return yield* Effect.tryPromise({
				try: () => pg.dumpDataDir('none'),
				catch: invalid
			}).pipe(Effect.uninterruptible);
		})
	);
/** The image from the workspace's cache, else built once and kept there (newest few) for the next test process. */
const storedImage = (dir: string, slice: typeof SchemaSliceSchema.Type) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const file = join(
			dir,
			`${createHash('sha256')
				.update(JSON.stringify([PGLITE, slice]))
				.digest('hex')}.tar`
		);
		const kept = yield* fs.readFile(file).pipe(Effect.option);
		if (Option.isSome(kept)) return new Blob([kept.value.slice()]);
		const image = yield* freshImage(slice);
		const bytes = new Uint8Array(yield* Effect.promise(() => image.arrayBuffer()));
		yield* fs.makeDirectory(dir, { recursive: true });
		// written whole, then renamed: a concurrent test process never reads half an image
		const temporary = `${file}.${randomUUID()}`;
		yield* fs.writeFile(temporary, bytes);
		yield* fs.rename(temporary, file);
		const images = yield* Effect.forEach(
			(yield* fs.readDirectory(dir)).filter((name) => name.endsWith('.tar')),
			(name) =>
				fs
					.stat(join(dir, name))
					.pipe(
						Effect.map((info) => ({ name, at: Option.getOrElse(info.mtime, () => new Date(0)) }))
					)
		);
		for (const old of images.toSorted((a, b) => b.at.getTime() - a.at.getTime()).slice(KEPT_IMAGES))
			yield* fs.remove(join(dir, old.name), { force: true });
		return image;
	}).pipe(Effect.provide(node), Effect.mapError(invalid));
let schemaImages: Cache.Cache<string, Blob, SchemaImageFailure> | undefined;
const images = Effect.suspend(() =>
	schemaImages === undefined
		? Cache.makeWith(
				(key: string): Effect.Effect<Blob, SchemaImageFailure> =>
					Effect.gen(function* () {
						const { dir, slice } = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(ImageKey)
						)(key).pipe(Effect.mapError(invalid));
						return yield* dir === null ? freshImage(slice) : storedImage(dir, slice);
					}),
				{
					capacity: 4,
					timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
				}
			).pipe(
				Effect.provideContext(Context.empty()),
				Effect.map((cache) => (schemaImages ??= cache))
			)
		: Effect.succeed(schemaImages)
);
const schemaDatabase = (manifest: EngineManifest, root: string | undefined) =>
	Effect.gen(function* () {
		const slice = schemaSlice(manifest);
		const key = JSON.stringify({
			dir: root === undefined ? null : join(root, '.norbital', 'cache', 'schema-images'),
			slice: root === undefined ? slice : { ...slice, connections: {} }
		});
		return PgliteDb.layer(yield* Cache.get(yield* images, key));
	});
const namedPack = (root: string, manifest: EngineManifest, name: 'base' | 'sample') =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		if (name === 'sample') {
			const dir = join(root, '.norbital', 'seed', 'sample');
			if (!(yield* fs.exists(join(dir, 'pack.json'))))
				return yield* Effect.fail(
					new KitInvalid({
						message: `TestWorkspace: no sample pack at ${dir}; run \`bolt build --bank <bank>\` first`
					})
				);
			return yield* readPack(dir);
		}
		const compiler = yield* Effect.tryPromise({
			try: () => import('../compiler/seed.ts'),
			catch: invalid
		});
		const artifact = yield* Effect.tryPromise({
			try: () => import('../compiler/artifact/seed.ts'),
			catch: invalid
		});
		const errors: import('../protocol/diagnostic.ts').CheckDiagnostic[] = [],
			cache = join(root, '.norbital', 'cache');
		const build = (out: string) =>
			Effect.gen(function* () {
				const pack = yield* compiler.seedPack(root, errors);
				yield* artifact.buildPacks(root, manifest, pack, out, { cache }, errors);
				if (errors.length > 0)
					return yield* Effect.fail(
						new KitInvalid({
							message: `TestWorkspace: the base pack failed:\n${errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
						})
					);
			});
		// under `bolt test` the pack is built once per run (as `runChecked` checks once), into its own directory and then
		// renamed, so a parallel test process never reads half a pack; the first rename wins
		const run = process.env['BOLT_TEST_RUN_CACHE'];
		if (run === undefined || run === '') {
			yield* build(join(cache, 'test-seed'));
			return yield* readPack(join(cache, 'test-seed', 'base'));
		}
		const shared = join(run, `seed-${createHash('sha256').update(root).digest('hex')}`);
		if (!(yield* fs.exists(join(shared, 'base', 'pack.json')))) {
			const temporary = `${shared}.${randomUUID()}`;
			yield* build(temporary);
			yield* fs
				.rename(temporary, shared)
				.pipe(Effect.catch(() => fs.remove(temporary, { recursive: true, force: true })));
		}
		return yield* readPack(join(shared, 'base'));
	}).pipe(Effect.provide(node), Effect.mapError(invalid));

const ResponseCassette = Schema.Struct({
	content: Schema.Json,
	toolCalls: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			input: Schema.Json,
			invalid: Schema.optionalKey(Schema.String)
		})
	),
	finish: Schema.Literals(['stop', 'tool', 'cut']),
	usage: Schema.Struct({
		input: Schema.Number,
		output: Schema.Number,
		cost: Schema.optionalKey(Schema.Number),
		call: Schema.optionalKey(Schema.String)
	}),
	continuation: Schema.optionalKey(Schema.String),
	reasoning: Schema.optionalKey(Schema.String)
});
/** A deterministic, zero-cost System 1 responder for tests: prefer the `respond` choice, otherwise the first choice, and return zero scores. */
export const respondSystem1: Ai['Service']['ask'] = (request) =>
	Effect.sync(() => ({
		costUsd: 0,
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
/** Schema-decoded cassettes bind one native Ai layer; no provider Promise adapter. */
export const CassetteAi = (options: CassetteOptions) =>
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
					yield* Schema.decodeUnknownEffect(ResponseCassette)(value).pipe(
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
		const infer = (request: AiRequest): Stream.Stream<AiEvent, PortFailure> =>
			Stream.unwrap(
				Effect.gen(function* () {
					requests.push(request);
					const next = turns.get(request.model)?.shift();
					if (next === undefined)
						// an exhausted cassette is the fixture's own refusal, never a provider blip to wait out
						return Stream.fail(
							new FacilityFailure({
								kind: 'invalid',
								message: `cassette: '${request.model}' has no turn left (${requests.length} requests played)`
							})
						);
					if (options.firstPartMs !== undefined) yield* Effect.sleep(options.firstPartMs);
					const events: AiEvent[] =
						typeof next.content === 'string' && next.content !== ''
							? [
									{ _tag: 'Delta', text: next.content },
									{ _tag: 'Response', response: next }
								]
							: [{ _tag: 'Response', response: next }];
					return Stream.fromIterable(events);
				})
			);
		return {
			requests,
			remaining: () => Object.fromEntries([...turns].map(([name, list]) => [name, list.length])),
			layer: Layer.succeed(Ai, {
				ask: options.sys_1 ?? respondSystem1,
				maxChoices: undefined,
				models: [...turns.keys()],
				catalog: Port.unavailable('ai.catalog'),
				infer,
				embed: () => Port.unavailable('ai.embed')
			})
		};
	}).pipe(Effect.provide(node), Effect.mapError(invalid));

/** A durable in-process audit facility for a bare engine context; `TestWorkspace.layer` builds its own. */
export const memoryAuditLayer: Layer.Layer<never> = Layer.unwrap(
	Effect.map(Effect.sync(memoryAudit), (store) =>
		auditFromAbi(store.port).pipe(Layer.provide(NodeCrypto.layer))
	)
);

/** A native test workspace service; its layer owns database and engine resources in scope and exposes the same host routes used by deployed workspaces. */
export class TestWorkspace extends Context.Service<TestWorkspace, Kit>()(
	'@norbital-ai/bolt/test/TestWorkspace'
) {
	static readonly layer = <P extends TestPorts>(
		options: TestOptions<P>
	): Layer.Layer<TestWorkspace | WorkspaceServices, KitFailure> =>
		Layer.effectContext(
			Effect.gen(function* () {
				let { manifest, guest, transforms } = options;
				const artifact = options.artifact;
				if (artifact !== undefined) ({ manifest, guest } = artifact);
				// a suite writes the rows its mechanism needs; the base pack is a product seed, not a test fixture
				const seed = options.seed ?? 'none';
				if (options.root !== undefined) {
					const built = yield* checked(options.root);
					if (built.errors.length > 0 || built.manifest === undefined)
						return yield* Effect.fail(
							new KitInvalid({
								message: `bolt check failed:\n${built.errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
							})
						);
					({ manifest, guest, transforms } = built);
				}
				if (manifest === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: 'TestWorkspace takes a root or a manifest' })
					);
				if (typeof seed === 'string' && seed !== 'none' && options.root === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: `TestWorkspace: seed '${seed}' needs a root` })
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
				const dbContext = yield* Layer.build(
						options.db ?? (yield* schemaDatabase(m, options.root))
					),
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
						),
					session: () => Effect.andThen(flush, inner.session())
				});
				let now = options.now ?? '2026-09-25T10:00:00.000Z';
				// the host's cron clock, stepped by `runDue`: a slot at or before this instant has had its turn
				let cronsThrough = Date.parse(now);
				const liveClock = Context.get(Context.empty(), Clock.Clock);
				const clock: Clock.Clock = {
					monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
					monotonicTimeNanos: liveClock.monotonicTimeNanos,
					sleep: (duration) => liveClock.sleep(duration),
					currentTimeMillisUnsafe: () => Date.parse(now),
					currentTimeMillis: Effect.sync(() => Date.parse(now)),
					currentTimeNanosUnsafe: () => BigInt(Date.parse(now)) * 1_000_000n,
					currentTimeNanos: Effect.sync(() => BigInt(Date.parse(now)) * 1_000_000n)
				};
				const auditStore = memoryAudit();
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
					options.fakes?.ai === undefined ? undefined : yield* CassetteAi(options.fakes.ai);
				const fakes: Fakes = {
					...f,
					...(cassette === undefined
						? {}
						: { ai: { requests: cassette.requests, remaining: cassette.remaining } })
				};
				const files = Layer.succeed(Files, {
					put: (bytes, meta) =>
						Effect.sync(() => {
							const key = randomUUID();
							f.files.blobs.set(key, bytes);
							return {
								key,
								bytes: bytes.byteLength,
								sha256: createHash('sha256').update(bytes).digest('hex'),
								mime: meta.mime
							};
						}),
					get: (key) =>
						Effect.suspend(() => {
							const bytes = f.files.blobs.get(key);
							return bytes === undefined
								? Port.unavailable('files', `no blob ${key}`)
								: Effect.succeed(bytes);
						}),
					url: (key) => Effect.succeed(`memory://${key}`),
					remove: (key) =>
						Effect.sync(() => {
							f.files.blobs.delete(key);
						}),
					// the host's rule without the network: media by its first bytes, anything else refused
					download: (url) =>
						Effect.suspend(() => {
							const bytes = f.files.origin.get(url);
							if (bytes === undefined)
								return Effect.fail(
									new FacilityFailure({
										kind: 'upstream',
										message: 'The URL answered 404.',
										status: 404
									})
								);
							const mime = mediaType(bytes.subarray(0, DOWNLOAD.headBytes));
							if (mime === undefined)
								return Effect.fail(
									new FacilityFailure({
										kind: 'invalid',
										message:
											'The file is not media (an image, audio, video or a PDF); nothing was stored.'
									})
								);
							const key = randomUUID();
							f.files.blobs.set(key, bytes);
							return Effect.succeed({
								key,
								bytes: bytes.byteLength,
								sha256: createHash('sha256').update(bytes).digest('hex'),
								mime,
								name: url.split(/[?#]/)[0]?.split('/').at(-1) || 'download'
							});
						})
				});
				const links =
					options.links === null
						? Drivers.unavailable
						: Layer.succeed(Drivers, {
								available: true,
								send: (instance, message, attachments) =>
									Effect.sync(() => {
										f.links.sent.push({
											instance,
											message,
											...(attachments === undefined ? {} : { attachments })
										});
										return { providerId: `${instance}:${f.links.sent.length}` };
									}),
								typing: (instance, to, on) =>
									Effect.sync(() => {
										f.links.typed.push({ instance, to, on });
									}),
								request: (instance, op) => f.links.answer(instance, op),
								read: (instance, sync, partition, cursor) =>
									f.links.page(instance, sync, partition, cursor),
								changed: () => Effect.void
							});
				const native = yield* nodePorts({
					...(artifact === undefined ? {} : { release: artifact.dir }),
					...(options.secretsKey === undefined
						? {}
						: { secretsKey: Redacted.value(options.secretsKey) })
				});
				const ports = Layer.mergeAll(
					auditFromAbi(auditStore.port).pipe(Layer.provide(NodeCrypto.layer)),
					files,
					links,
					Http.fromAbi(native.http),
					Images.fromAbi(native.images),
					Docs.fromAbi(native.docs),
					Mcp.fromAbi(native.mcp),
					Layer.succeed(Logs, {
						write: (event) =>
							Effect.sync(() => {
								f.logs.push({ ...event, id: String(f.logs.length + 1) });
							}),
						query: (query) => Effect.sync(() => readLogRows(f.logs, query))
					}),
					Convert.unavailable,
					Speech.unavailable,
					WebRead.unavailable,
					Browser.unavailable,
					Geo.unavailable,
					Metering.unavailable,
					Layer.succeed(Transport, {
						send: (message) =>
							Effect.sync(() => {
								f.sent.push(message);
								return { providerId: `${message._tag}:${f.sent.length}` };
							})
					}),
					Layer.succeed(DeadlinePort, {
						announce: (scope, at) =>
							Effect.sync(() => {
								f.deadlines.announced.push({ scope, at });
							}),
						settle: () => Effect.void,
						teardown: () => Effect.void
					}),
					cassette?.layer ?? Ai.unavailable
				);
				const hostPorts =
					overrides === undefined ? ports : Layer.merge(ports, Layer.succeedContext(overrides));
				const {
					envoys: envoyConfig,
					agent: agentConfig,
					secure: hostSecure,
					...shellConfig
				} = options.host ?? {};
				const publicUrl = shellConfig.publicUrl ?? 'http://localhost';
				const secure = hostSecure ?? new URL(publicUrl).protocol === 'https:';
				const base = Layer.mergeAll(
					node,
					Keys.fromAbi(native.keys),
					GuestIsolates.fromAbi(native.guestIsolates),
					Layer.succeed(EnvoyConfig, envoyConfig ?? {}),
					Layer.effect(AgentHost, withBrowser(agentConfig ?? {})).pipe(Layer.provide(hostPorts)),
					hostPorts,
					Layer.succeed(TenantDb, db),
					Layer.succeed(Clock.Clock, clock),
					Layer.succeed(Activation, {
						scope: 'test',
						epoch: '',
						release: artifact?.artifact.hash ?? 'test',
						publicUrl,
						guest: Option.fromNullishOr(guest),
						start: []
					})
				);
				// In-process images already hold this exact slice; persistent and injected databases need reassertion.
				if (options.db !== undefined || options.root !== undefined)
					yield* applyPlan(db, yield* plan(yield* readApplied(db), m), { accept: true });
				if (options.pack !== undefined || seed === 'base' || seed === 'sample') {
					if (options.pack === undefined && options.root === undefined)
						return yield* Effect.fail(
							new KitInvalid({ message: 'a named seed pack needs a root' })
						);
					const pack =
						options.pack ??
						(yield* namedPack(options.root ?? '', m, seed === 'sample' ? 'sample' : 'base'));
					const artifact = yield* Effect.tryPromise({
						try: () => import('../engine/artifact/read.ts'),
						catch: invalid
					});
					const portContext = yield* Layer.build(hostPorts);
					yield* artifact
						.loadPackWithAssets(db, m, sourceOf(pack), Context.get(portContext, Files), now)
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
						yield* loadPack(db, m, sourceOf(pack), now);
					} else yield* restore(m, db, restoreSource(seed), now);
				}
				const engineContext = yield* Layer.build(EngineLive(m).pipe(Layer.provideMerge(base)));
				const runs = Context.get(engineContext, Runs),
					runHandlers = Context.get(engineContext, RunHandlers),
					envoys = Context.get(engineContext, Envoys),
					integration = Context.get(engineContext, Conversations);
				const Mail = Schema.Struct({
					to: Schema.String,
					subject: Schema.String,
					text: Schema.String,
					html: Schema.optionalKey(Schema.String),
					link: Schema.optionalKey(Schema.String)
				});
				const Sms = Schema.Struct({ to: Schema.String, text: Schema.String });
				const identityHost: IdentityHost = yield* makeIdentityHost({
					audit: yield* auditShape(auditStore.port).pipe(Effect.provide(NodeCrypto.layer)),
					db,
					now: Effect.sync(() => new Date(now)),
					windows: new RateWindows(),
					keys: yield* loadKeys(db),
					mail: {
						async send(_kind, value) {
							const message = Schema.decodeUnknownSync(Mail)(value);
							f.sent.push({ _tag: 'Mail', ...message });
							return { providerId: `Mail:${f.sent.length}` };
						}
					},
					sms: {
						async send(_kind, value) {
							const message = Schema.decodeUnknownSync(Sms)(value);
							f.sent.push({ _tag: 'Sms', ...message });
							return { providerId: `Sms:${f.sent.length}` };
						}
					},
					phone: loggedPhone(() => {}, true),
					devSink: true,
					publicUrl,
					...(signupOf(m) === undefined ? {} : { signup: signupOf(m) })
				}).pipe(Effect.provide(NodeCrypto.layer));
				const shellBase = Layer.mergeAll(
					RateLimits.layer.pipe(Layer.provide(Layer.succeed(TenantDb, db))),
					Layer.succeed(HostIdentity, identityHost),
					Turnstile.dev,
					Layer.succeed(ShellConfig, {
						publicUrl,
						workspace: () => ({ name: 'Test', handle: 'test' }),
						secure,
						...shellConfig
					}),
					Layer.succeedContext(engineContext)
				);
				const authorities = new Map<string, Authority>();
				const session = Layer.succeed(SessionAuthority, {
					of: (request) => {
						const authority = authorities.get(request.headers['bolt-test-authority'] ?? '');
						return authority === undefined
							? authorityOf(request).pipe(
									Effect.map(Option.fromNullishOr),
									Effect.provide(shellBase),
									Effect.provideService(TenantDb, db)
								)
							: Effect.succeed(Option.some(authority));
					}
				});
				const hostContext = yield* Layer.build(
					BoltHostLive.pipe(
						Layer.provideMerge(session),
						Layer.provideMerge(ShellRoutes),
						Layer.provideMerge(shellBase)
					)
				);
				const host = Context.get(hostContext, BoltHost);
				const renderer =
					artifact === undefined
						? Option.none()
						: Option.some(
								Context.get(
									yield* Layer.build(
										publicPages(artifact).pipe(Layer.provide(Layer.succeedContext(hostContext)))
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
				const answer = nativeAnswers(m),
					storedAnswer = nativeAnswers(m, 'workspace');
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
								'invalidInput',
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
				function storedQuery<const R extends ReadRequestBase>(
					request: ReadRequest<R>
				): Eff<ReadAnswer<R, false>>;
				function storedQuery(request: ReadRequestJson): Eff<DynamicAnswer, ReadFailed>;
				function storedQuery(request: unknown): Effect.Effect<unknown, ReadFailed> {
					const query = Effect.gen(function* () {
						const b = yield* bindings;
						// a read request crosses as its one argument, all roots in one crossing
						const args = yield* decodeArgs([request]);
						const ir = yield* Effect.try({
							try: () => lowerRead(m, 'db.query', args),
							catch: decodeFailure
						});
						const value = (yield* storedReads.run([ir], { as: 'workspace' }, b))[0];
						if (value === undefined)
							return yield* Effect.fail(
								new ReadFailed({
									code: 'protocol',
									message: 'The host returned no stored read answer.'
								})
							);
						return yield* storedAnswer.read(request, value);
					});
					return query.pipe(Effect.mapError(readFailure), Effect.provide(hostContext));
				}
				const bodyActs: Kit['bodyActs'] = (who) => {
					const authority =
						'models' in who ? who : compileAuthority(m, who, `test:${randomUUID()}`);
					const batch = (acts: unknown) =>
						Effect.gen(function* () {
							const input = yield* Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({
										callable: Schema.String,
										input: Schema.Json,
										observed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
										onConflict: Schema.optionalKey(Schema.Literals(['update', 'keep']))
									})
								),
								{ onExcessProperty: 'error' }
							)(acts).pipe(
								Effect.mapError(
									(error) => new ActRefused({ code: 'invalidInput', message: error.message })
								)
							);
							const native: ActsRequest['acts'][number][] = [];
							for (const act of input) {
								const callable = yield* Effect.fromResult(parseCallable(act.callable, m)).pipe(
									Effect.mapError(
										(error) => new ActRefused({ code: error.code, message: error.message })
									)
								);
								if (!isBatchCallable(callable))
									return yield* Effect.fail(
										new ActRefused({
											code: 'invalidInput',
											message: 'An act batch takes create, update, upsert or delete.'
										})
									);
								if (
									callable.verb === 'upsert'
										? act.onConflict === undefined
										: act.onConflict !== undefined
								)
									return yield* Effect.fail(
										new ActRefused({
											code: 'invalidInput',
											message: 'A batch upsert requires onConflict; other verbs do not take it.'
										})
									);
								native.push({
									model: callable.model,
									verb: callable.verb,
									input: act.input,
									...(act.observed === undefined ? {} : { observed: act.observed }),
									...(act.onConflict === undefined ? {} : { onConflict: act.onConflict })
								});
							}
							const b = yield* bindings,
								key = randomUUID();
							const { outcome } = yield* calls
								.acts({
									name: 'act.many',
									acts: native,
									key,
									issuedAt: b.now,
									authority,
									bindings: b,
									invocationId: key,
									from: 'Server'
								})
								.pipe(Effect.orDie);
							const failure = actFailure(outcome);
							if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
							return outcome;
						}).pipe(Effect.provide(hostContext));
					return {
						checked: (acts) =>
							batch(acts).pipe(
								Effect.flatMap((outcome) => answer.checked(outcome).pipe(Effect.orDie))
							),
						many: <const A extends ActBatch>(acts: ActManyInput<A>) =>
							Effect.gen(function* () {
								const outcome = yield* batch(acts);
								return yield* answer.many<A>(outcome, acts).pipe(Effect.orDie);
							}).pipe(Effect.provide(hostContext))
					};
				};
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
					const act = (callable: string, input: unknown, opts: ActOptions = {}) =>
						Effect.gen(function* () {
							const { key: id = randomUUID(), retry, ...rest } = opts;
							const response = yield* request(
								PATHS.act,
								{ callable, input, issuedAt: now, ...rest },
								{ [HEADERS.key]: id, ...(retry ? { [HEADERS.retry]: '1' } : {}) }
							);
							const answer = yield* responseJson(response);
							const error = Schema.decodeUnknownOption(WireError)(answer);
							if (Option.isSome(error)) {
								const code = refusalOfStatus(response.status);
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
							const failure = actFailure(reply.outcome);
							if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
							// past the person-wait the write runs on as its run: `running` is an outcome, not a defect
							if (
								reply.outcome.kind === 'pendingApproval' ||
								reply.outcome.kind === 'committed' ||
								reply.outcome.kind === 'running'
							)
								return reply.outcome;
							return yield* Effect.die(reply.outcome);
						}).pipe(Effect.catchTag('KitInvalid', Effect.die));
					const readError = (error: { readonly message: string }) =>
						new ReadFailed({ code: 'protocol', message: error.message });
					// a read request crosses as `{ m: 'query', a: [request] }`, as the page's and a body's do
					function callerQuery<const R extends ReadRequestBase>(
						request: ReadRequest<R>
					): Eff<ReadAnswer<R>, ReadFailed>;
					function callerQuery(request: ReadRequestJson): Eff<DynamicAnswer, ReadFailed>;
					function callerQuery(request: unknown): Effect.Effect<unknown, ReadFailed> {
						return read('query', [request]).pipe(
							Effect.flatMap((value) =>
								answer.read(request, value).pipe(Effect.mapError(readError))
							)
						);
					}
					// `history(model, id, { at })` crosses as `{ m: 'history', a: [model, id, at?] }`, as the page's does
					function history<C extends string>(
						model: Is<C, ReadableName>,
						id: NoInfer<Id<C>>,
						options?: HistoryOptions
					): Eff<readonly Revision<C>[], ReadFailed>;
					function history(
						model: string,
						id: string,
						options: HistoryOptions = {}
					): Effect.Effect<unknown, ReadFailed> {
						return read('history', [
							model,
							id,
							...(options.at === undefined ? [] : [options.at])
						]).pipe(
							Effect.flatMap((value) =>
								answer.history(model, value).pipe(Effect.mapError(readError))
							)
						);
					}
					return {
						authority,
						query: callerQuery,
						history,
						act: <const N extends string>(
							name: Is<N, KitCallable>,
							input: NoInfer<KitInput<N>>,
							opts?: ActOptions
						) =>
							act(String(name), input, opts).pipe(
								Effect.flatMap(
									(value): Effect.Effect<Committed<ActOutput<N>, N> | PendingApproval<N>> =>
										// a kit's write answers within its call (no person waits 60 s on a test): a hand-off is a broken fixture
										value.kind === 'running'
											? Effect.die(
													new Error(
														`${String(name)} was handed off to run ${value.run}; a kit write answers within its call`
													)
												)
											: answer.act<N>(name, value).pipe(Effect.orDie)
								)
							),
						start: <const A extends string>(
							name: Is<A, StartableName>,
							input: NoInfer<StartInput<A>>,
							opts?: { id?: string }
						) =>
							act('start', {
								automation: name,
								input,
								id: opts?.id ?? uuidv7(Date.parse(now))
							}).pipe(
								Effect.flatMap((value) =>
									// a start answers once the run is recorded, never past the person-wait
									value.kind === 'running'
										? Effect.die(value)
										: answer.start<A>(value).pipe(Effect.orDie)
								)
							),
						approvals: {
							decide: (requestId, input) =>
								act('approvals.decide', { requestId, ...input }).pipe(
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
									output: { ...output, ...fileRef(output) },
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
						teamPath: [],
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
					storedQuery,
					bodyActs,
					fakes,
					syncs: {
						read: (name, options = {}) =>
							syncsOf(m).get(name)?.read === true
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
						},
						advance: (value) => {
							now = new Date(Date.parse(now) + duration(value)).toISOString();
						}
					},
					as: (who) =>
						caller('models' in who ? who : compileAuthority(m, who, `test:${randomUUID()}`)),
					visitor: (app, opts) =>
						caller(new Authorities(m, 'test').visitor(app, randomUUID()), opts?.ip),
					signIn: (address) =>
						Effect.gen(function* () {
							const addressParts = parseAddress(address);
							if (addressParts === null)
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							const [result] = yield* db.read([
								{
									text: `SELECT id FROM sys_user WHERE ${memberColumn(addressParts, '$1')}`,
									params: [memberValue(addressParts)]
								}
							]);
							const id = result?.rows[0]?.['id'];
							if (typeof id !== 'string')
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							const authority = yield* new Authorities(m, 'test').member(db, id);
							if (authority === null)
								return yield* Effect.fail(
									new KitInvalid({ message: `no active member with the address ${address}` })
								);
							return authority;
						}),
					runDue: () =>
						Effect.gen(function* () {
							const at = Date.parse(now);
							for (const entry of yield* runs.crons) {
								const cron = yield* Effect.orDie(
									Effect.fromResult(Cron.parse(entry.cron, entry.zone))
								);
								// the latest slot since the last step, once; slots skipped meanwhile are not replayed. `prev` is
								// strict at whole seconds (as the host's clock): one second past finds a slot at `at` itself
								const slot = Cron.prev(cron, at + 1000);
								if (slot.getTime() > cronsThrough) yield* runs.fire(entry.id, slot.toISOString());
							}
							cronsThrough = at;
							yield* runs.tick;
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
							yield* runs.boot;
						}).pipe(Effect.provide(hostContext)),
					settled: () =>
						Effect.andThen(envoys.settled, host.settled).pipe(Effect.provide(hostContext)),
					receive: (instance, messages, opts = {}) =>
						Effect.gen(function* () {
							yield* integration.receive(instance, {
								kind: 'messages',
								messages: Array.isArray(messages) ? messages : [messages],
								...opts
							});
							yield* runs.tick;
							yield* envoys.settled;
						}).pipe(Effect.provide(hostContext)),
					handle,
					session: (id) =>
						mint(identityHost, id).pipe(
							Effect.map((session) => `${cookieNames(secure).session}=${session.token}`),
							Effect.mapError(invalid)
						)
				};
				count.reset();
				return Context.add(hostContext, TestWorkspace, kit);
			})
		);
}
