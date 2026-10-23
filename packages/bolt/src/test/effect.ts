// The workspace kit is a scoped Effect layer; its callers use the same routes as a real host.
import { inputSchema, type Fields, type Kind } from '@norbital-ai/std/kind';
import * as EffectVitest from '@effect/vitest';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
	Clock,
	Cache,
	Context,
	type Crypto,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Schema,
	SchemaGetter,
	Semaphore,
	Stream
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import type { PlatformError } from 'effect/PlatformError';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileRef } from '../page/file-ref.ts';
import { BUILTIN_FIELDS } from '../decl/builtin-fields.ts';
import type { StartableName } from '../decl/access/policy.ts';
import type {
	Act,
	ActInput,
	ActOutput,
	Callable,
	Committed,
	DeclaredQuery,
	DeclaredRow,
	ListResult,
	Page,
	Paged,
	PendingApproval,
	QueryCallable,
	QueryInput,
	QueryOutput,
	ReadMember,
	ReadSet,
	ReadSetAnswer,
	ReadResult,
	Select,
	StoredAnswer,
	StoredMember,
	WorkspaceReads
} from '../decl/ctx.ts';
import {
	type ActFailure,
	ActRefused,
	ActUnknown,
	actFailure,
	FacilityFailure,
	ReadFailed
} from '../decl/errors.ts';
import type { Is, ReadableName, WorkspaceReadField } from '../decl/names.ts';
import { nullableOfExpr } from '../decl/model.ts';
import type { StartInput } from '../decl/runtime/facilities.ts';
import type { FileRef, Id, Json } from '../decl/values.ts';
import type { ModelWhere, OrderBy, Where } from '../decl/where.ts';
import { compileAuthority, type Holder } from '../engine/access/authority.ts';
import { parseCallable } from '../engine/callables/index.ts';
import { AgentHost } from '../engine/agent/index.ts';
import { withBrowser } from '../engine/agent/browser.ts';
import { EnvoyConfig } from '../engine/envoys/index.ts';
import { RateWindows } from '../engine/access/rate.ts';
import type {
	AiRequest,
	AiResponse,
	Authority,
	DriverPage,
	EngineActor,
	Sql
} from '../engine/contracts.ts';
import { PgliteDb, Pristine } from '../engine/db/pglite.ts';
import type { Artifact } from '../engine/artifact/read.ts';
import { TenantDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { DbError, type EngineError } from '../engine/errors.ts';
import { BoltError } from '../protocol/errors.ts';
import { EngineLive, type EngineServices } from '../engine/host.ts';
import { GuestConfig, type GuestOptions, type GuestProgram } from '../engine/guest/runner.ts';
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
import { decodeManifest, layered, type EngineManifest } from '../engine/manifest.ts';
import { Port, type PortFailure } from '../engine/port.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead,
	Browser,
	type AiEvent,
	type TransportMessage
} from '../engine/ports.ts';
import { applyPlan, plan, readApplied, schemaSlice } from '../engine/schema/plan.ts';
import { SchemaSliceSchema } from '../engine/schema/ddl.ts';
import { lowerRead } from '../engine/query/engine.ts';
import { lowerKeyedMember } from '../engine/query/keyed.ts';
import {
	Activation,
	Callables,
	Conversations,
	Envoys,
	Reads,
	Runs,
	type ActsRequest,
	type OutboundFile,
	type ShapeOf
} from '../engine/services.ts';
import { duration } from '../engine/runs/time.ts';
import { IDENTITY, loadPack, readPack, type Pack } from '../engine/write/pack.ts';
import { seed as restore, type SeedPack } from '../engine/write/seed.ts';
import { BoltHost, BoltHostLive } from '../protocol/host.ts';
import { PublicPages, publicPages } from '../protocol/pages.ts';
import {
	catalog,
	collectionOf,
	defaultFields,
	storedFields,
	SYSTEM_COLUMNS
} from '../protocol/catalog.ts';
import { bindings, RateLimits, SessionAuthority } from '../protocol/http.ts';
import { declaredQuery, select } from '../protocol/ir.ts';
import type { SelectIR } from '../protocol/ir-types.ts';
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
/** The workspace's generated and authored callables, including collection erase operations exercised by the test host. */
export type KitCallable = Callable | `${ReadableName}.erase`;
/** A callable's native typed input; erase operations accept one or more collection ids and an optional replacement set. */
export type KitInput<N> = N extends `${infer C}.erase`
	? { target: Id<C> | readonly Id<C>[]; set?: Readonly<Record<string, Json>> }
	: ActInput<N>;
/** Reads, queries, writes, uploads and automation starts through the real host routes under one authority, with native decoded values and typed failures. */
export interface Caller {
	read<C extends string>(
		collection: Is<C, ReadableName>,
		query: DeclaredQuery
	): Effect.Effect<Page<DeclaredRow<C>>, ReadFailed>;
	readonly authority: Authority;
	act<const N extends string>(
		callable: Is<N, KitCallable>,
		input: NoInfer<KitInput<N>>,
		options?: ActOptions
	): Effect.Effect<Committed<ActOutput<N>, N> | PendingApproval<N>, ActFailure>;
	query<const N extends string>(
		name: Is<N, QueryCallable>,
		input: NoInfer<QueryInput<N>>
	): Effect.Effect<QueryOutput<N>, ReadFailed>;
	start<const A extends string>(
		automation: Is<A, StartableName>,
		input: NoInfer<StartInput<A>>,
		options?: { id?: string }
	): Effect.Effect<Committed<unknown> | PendingApproval, ActFailure>;
	upload(
		field: `${string}.${string}`,
		file: { name: string; mime: string; bytes: Uint8Array; id?: string }
	): Effect.Effect<Committed<FileRef> | PendingApproval, ActFailure>;
	read<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		q: {
			where?: NoInfer<Where<C>>;
			select?: S;
			orderBy?: NoInfer<OrderBy<C>>;
			search?: string;
		} & Paged
	): Effect.Effect<Page<ListResult<C, S>>, ReadFailed>;
	read<const M extends ReadSet>(
		set: M & { readonly [K in keyof M]: ReadMember<M[K]['collection']> }
	): Effect.Effect<ReadSetAnswer<M>, ReadFailed>;
	get<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		q?: { select?: S; revision?: number }
	): Effect.Effect<ReadResult<C, S> | null, ReadFailed>;
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
/** The default integration driver fake: inspect sent messages and typing notices, or supply native Effect handlers for requests and feed pages. */
export type FakeLinks = {
	readonly sent: { instance: string; message: Json; attachments?: readonly OutboundFile[] }[];
	readonly typed: { instance: string; to: string }[];
	answer: (instance: string, op: Json) => Effect.Effect<Json, PortFailure>;
	page: (
		instance: string,
		feed: string,
		partition: string,
		cursor: Json | null
	) => Effect.Effect<DriverPage, PortFailure>;
};
/** Observations of the kit's default file, deadline, transport and integration ports, plus AI requests and remaining responses when cassette playback is enabled. */
export type Fakes = {
	readonly files: { readonly blobs: Map<string, Uint8Array> };
	readonly deadlines: { readonly announced: { scope: string; at: string }[] };
	readonly sent: TransportMessage[];
	readonly links: FakeLinks;
	readonly ai?: {
		readonly requests: readonly AiRequest[];
		remaining(): { readonly [modelClass: string]: number };
	};
};
/** Host port service keys a test may replace with native Layers, including file storage, conversion, speech, web, geography, transport and AI. */
export type TestPorts =
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
	| Ai;
/** Workspace fixture and host configuration: use a verified release, check authored source, or supply a manifest/guest; choose seed data, control time, and native ports. */
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
	cpu?: GuestOptions['cpu'];
} & (
	| {
			/** A release verified by readArtifact; public HTTP requests execute its isolated server programs. */
			artifact: Artifact;
			root?: never;
			manifest?: never;
			guest?: never;
			transforms?: never;
			projections?: never;
	  }
	| {
			artifact?: never;
			root?: string;
			manifest?: EngineManifest;
			guest?: GuestProgram;
			transforms?: Iterable<string>;
			projections?: Iterable<string>;
	  }
);
/** A scoped workspace's test controls: create callers, inspect native rows and port observations, advance its clock, run due work, and exercise real HTTP and integration entry points. */
export type Kit = {
	readonly manifest: EngineManifest;
	/** The verified artifact hash, or the explicit in-memory test release. */
	readonly release: string;
	readonly db: TenantDbShape;
	/** The transform's native, unmasked stored reader, scoped to this workspace. */
	readonly storedRead: WorkspaceReads['read'];
	/** An action/automation's native batch writer, under this caller's authority. */
	bodyActs(who: Holder | Authority): Pick<Act, 'many'>;
	readonly fakes: Fakes;
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
	| Activation
	| ShellConfig
	| HostIdentity
	| Turnstile
	| SessionAuthority;

declare const storedReader: WorkspaceReads['read'];
type StoredReadAnswer<
	C extends string,
	S extends { readonly [P in WorkspaceReadField<C>]?: true }
> = Effect.Success<ReturnType<typeof storedReader<C, S>>>;
type StoredSetAnswer<M extends ReadSet> = { readonly [K in keyof M]: StoredAnswer<M[K]> };
type NativeMethod =
	| 'read'
	| 'declared'
	| 'get'
	| 'set'
	| 'query'
	| 'act'
	| 'start'
	| 'storedRead'
	| 'storedDeclared'
	| 'storedSet'
	| 'many';
type NativeAnswer<K extends NativeMethod, N extends string, S, M extends ReadSet> = K extends 'read'
	? Page<ListResult<N, S>>
	: K extends 'declared' | 'storedDeclared'
		? Page<DeclaredRow<N>>
		: K extends 'storedRead'
			? S extends { readonly [P in WorkspaceReadField<N>]?: true }
				? StoredReadAnswer<N, S>
				: never
			: K extends 'storedSet'
				? StoredSetAnswer<M>
				: K extends 'get'
					? ReadResult<N, S> | null
					: K extends 'set'
						? ReadSetAnswer<M>
						: K extends 'query'
							? QueryOutput<N>
							: K extends 'act'
								? Committed<ActOutput<N>, N> | PendingApproval<N>
								: K extends 'many'
									? Committed<readonly unknown[]>
									: Committed<unknown> | PendingApproval;

/** Native results use the host's catalogue and kind codecs; only caller values admit masks. */
const nativeAnswers = (manifest: EngineManifest, readAs: 'caller' | 'workspace' = 'caller') => {
	const m = layered(manifest),
		cat = catalog(m);
	const absent = Schema.Null.pipe(
		Schema.decodeTo(Schema.Undefined, {
			decode: SchemaGetter.transform(() => undefined),
			encode: SchemaGetter.transform(() => null)
		})
	);
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
	const identity = (collection: string) => {
		const info = cat.models.get(collection);
		if (info === undefined) throw new KitInvalid({ message: `unknown model '${collection}'` });
		return info.fields.get('id')?.pg === 'uuid'
			? inputSchema({ kind: 'id', of: collection })
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
	const admits = Schema.Union([Schema.Literal('all'), Schema.Array(Schema.String)]);
	const grantFields = Schema.Struct({
		read: Schema.optionalKey(Schema.Unknown),
		fields: Schema.optionalKey(admits)
	});
	const readFields = Schema.Struct({ fields: Schema.optionalKey(admits) });
	const maskable = (collection: string, field: string) =>
		!SYSTEM_COLUMNS.some((name) => name === field) &&
		Object.values(m.policies).some((policy) => {
			const grant = Schema.decodeUnknownOption(grantFields)(policy.grants[collection]);
			if (Option.isNone(grant) || grant.value.read === undefined) return false;
			const read = Schema.decodeUnknownOption(readFields)(grant.value.read);
			const admitted = Option.isSome(read)
				? (read.value.fields ?? grant.value.fields)
				: grant.value.fields;
			return admitted !== undefined && admitted !== 'all' && !admitted.includes(field);
		});
	const row = (collection: string, selected: SelectIR, heavy = false): Schema.Decoder<unknown> => {
		const info = collectionOf(cat, collection),
			model = m.models[collection];
		const columns: Record<string, Schema.Decoder<unknown>> = { id: identity(collection) };
		for (const name of selected.fields ??
			(readAs === 'workspace' ? storedFields(info.model) : defaultFields(info, heavy))) {
			if (name === 'id') continue;
			const relation = m.relationships[`${collection}.${name}`];
			const declared = model?.fields[name],
				computed = model?.computed?.[name];
			let codec: Schema.Decoder<unknown>;
			if (relation !== undefined) {
				codec =
					typeof relation.to === 'string'
						? identity(relation.to)
						: Schema.Union(
								relation.to.map((target) =>
									Schema.Struct({ collection: Schema.Literal(target), id: identity(target) })
								)
							);
				if (relation.optional) codec = Schema.NullOr(codec);
			} else if (declared !== undefined) codec = kind(declared);
			else if (computed !== undefined) {
				const value = computedKinds[computed.kind];
				codec =
					model === undefined || nullableOfExpr(computed.expr, model)
						? Schema.NullOr(value)
						: value;
			} else if (name === 'revision') codec = Schema.Int;
			else if (name === 'created_at' || name === 'updated_at')
				codec = inputSchema({ kind: 'instant' });
			else if (name === 'created_by' || name === 'updated_by')
				codec = Schema.NullOr(identity('sys_user'));
			else throw new KitInvalid({ message: `unknown field '${collection}.${name}'` });
			columns[name] =
				readAs === 'caller' && maskable(collection, name) ? Schema.Union([codec, masked]) : codec;
		}
		for (const [name, relation] of Object.entries(selected.relations)) {
			const member = row(relation.target, relation.select);
			columns[name] = relation.many ? Schema.Array(member) : Schema.NullOr(member);
		}
		return Schema.Struct({
			...columns,
			$outbound: Schema.optionalKey(
				Schema.Record(
					Schema.String,
					Schema.Struct({
						status: Schema.Literals([
							'queued',
							'sending',
							'sent',
							'skipped',
							'failed',
							'uncertain'
						]),
						error: Schema.NullOr(Schema.String)
					})
				)
			),
			$approval: Schema.optionalKey(
				Schema.Struct({
					requestId: Schema.String,
					state: Schema.Literals(['Pending', 'ChangesRequested']),
					step: Schema.Number,
					steps: Schema.Number,
					requestedBy: Schema.String,
					waitingOn: Schema.Array(Schema.String)
				})
			)
		});
	};
	const read = (collection: string, selection: unknown, one: boolean) => {
		const member = row(collection, select(cat, collection, selection), one);
		return one
			? Schema.NullOr(member)
			: Schema.Struct({ rows: Schema.Array(member), next: Schema.NullOr(Schema.String) });
	};
	const records = Schema.Array(
		Schema.Union(
			[...cat.collections.keys()].map((collection) =>
				Schema.Struct({
					collection: Schema.Literal(collection),
					id: identity(collection),
					revision: Schema.Int
				})
			)
		)
	);
	const outputOf = (
		method: 'act' | 'start',
		name: string,
		input: unknown
	): Schema.Decoder<unknown> => {
		const dot = name.lastIndexOf('.'),
			collection = name.slice(0, dot),
			callable = name.slice(dot + 1);
		const action = m.collections[collection]?.actions?.[callable],
			declared = action?.output;
		const many =
			action?.target === 'record' &&
			Schema.is(Schema.Struct({ target: Schema.Array(Schema.Unknown) }))(input);
		const actionOutput = declared === undefined ? absent : kind(declared);
		return method === 'start'
			? Schema.Struct({ id: Schema.String, automation: Schema.String })
			: action !== undefined
				? many
					? Schema.Array(actionOutput)
					: actionOutput
				: callable === 'upsert'
					? Schema.Array(Schema.NullOr(identity(collection)))
					: callable === 'import'
						? Schema.Struct({
								rows: Schema.Array(
									Schema.Struct({
										index: Schema.NullOr(Schema.Int),
										id: Schema.NullOr(identity(collection)),
										action: Schema.Literals(['created', 'updated', 'kept', 'skipped', 'deleted'])
									})
								)
							})
						: absent;
	};
	const codec = (
		method: NativeMethod,
		name: string,
		selection: unknown,
		members: ReadSet,
		input: unknown
	): Schema.Decoder<unknown> => {
		if (method === 'read' || method === 'storedRead' || method === 'get')
			return read(name, selection, method === 'get');
		if (method === 'declared' || method === 'storedDeclared')
			return read(name, declaredQuery(cat, name, selection, readAs).select, false);
		if (method === 'set' || method === 'storedSet')
			return Schema.Struct(
				Object.fromEntries(
					Object.entries(members).map(([key, member]): [string, Schema.Decoder<unknown>] => [
						key,
						read(member.collection, 'select' in member ? member.select : undefined, 'id' in member)
					])
				)
			);
		if (method === 'many') {
			const acts = Schema.decodeUnknownSync(
				Schema.Array(Schema.Struct({ callable: Schema.String, input: Schema.Json }))
			)(input);
			return Schema.Struct({
				kind: Schema.Literal('committed'),
				output: Schema.Tuple(acts.map((act) => outputOf('act', act.callable, act.input))),
				records
			});
		}
		const dot = name.lastIndexOf('.'),
			collection = name.slice(0, dot),
			callable = name.slice(dot + 1);
		if (method === 'query') {
			const output = m.collections[collection]?.queries?.[callable]?.output;
			if (output === undefined) throw new KitInvalid({ message: `unknown query '${name}'` });
			return kind(output);
		}
		const output = outputOf(method, name, input);
		return Schema.Union([
			Schema.Struct({ kind: Schema.Literal('pendingApproval'), requestId: Schema.String, records }),
			Schema.Struct({ kind: Schema.Literal('committed'), output, records })
		]);
	};
	return <K extends NativeMethod, N extends string, S = {}, M extends ReadSet = ReadSet>(
		method: K,
		name: string,
		value: unknown,
		selection?: S,
		members?: M,
		input?: unknown
	) =>
		Effect.gen(function* () {
			const schema = yield* Effect.try({
				try: () => codec(method, name, selection, members ?? {}, input),
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
			const branded = Schema.declare((answer: unknown): answer is NativeAnswer<K, N, S, M> =>
				Schema.is(Schema.toType(schema))(answer)
			);
			return yield* Schema.decodeUnknownEffect(branded)(decoded);
		});
};
const invalid = (e: unknown) =>
	new KitInvalid({ message: e instanceof Error ? e.message : String(e) });
const node = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
);
type CheckResult = import('../compiler/check/index.ts').CheckResult;
const compiled = new Map<string, Effect.Effect<CheckResult, KitInvalid>>();
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
	errors: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			path: Schema.String,
			line: Schema.optionalKey(Schema.Number),
			message: Schema.String,
			help: Schema.optionalKey(Schema.String)
		})
	),
	manifest: Schema.optionalKey(Schema.Json),
	guest: Schema.optionalKey(
		Schema.Struct({
			source: Schema.String,
			sourceMap: Schema.optionalKey(Schema.String),
			assets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
		})
	),
	transforms: Schema.Array(Schema.String),
	projections: Schema.Array(Schema.String),
	seed: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json)))
	)
});
const toRun = (c: CheckResult): typeof RunChecked.Encoded => ({
	stages: c.stages,
	errors: c.errors,
	transforms: c.transforms,
	projections: c.projections,
	...(c.manifest === undefined
		? {}
		: { manifest: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(c.manifest))) }),
	...(c.seed === undefined ? {} : { seed: c.seed }),
	...(c.guest === undefined
		? {}
		: {
				guest: {
					source: c.guest.source,
					...(c.guest.sourceMap === undefined ? {} : { sourceMap: c.guest.sourceMap }),
					...(c.guest.assets === undefined
						? {}
						: {
								assets: Object.fromEntries(
									Object.entries(c.guest.assets).map(([hash, bytes]) => [
										hash,
										Buffer.from(bytes).toString('base64')
									])
								)
							})
				}
			})
});
const fromRun = (r: typeof RunChecked.Type) =>
	Effect.gen(function* () {
		const manifest =
			r.manifest === undefined
				? undefined
				: yield* Effect.fromResult(decodeManifest(r.manifest)).pipe(Effect.mapError(invalid));
		const assets = r.guest?.assets;
		const result: CheckResult = {
			stages: [...r.stages],
			errors: r.errors.map((e) => ({ ...e })),
			transforms: [...r.transforms],
			projections: [...r.projections],
			...(manifest === undefined ? {} : { manifest }),
			...(r.seed === undefined ? {} : { seed: r.seed }),
			...(r.guest === undefined
				? {}
				: {
						guest: {
							source: r.guest.source,
							...(r.guest.sourceMap === undefined ? {} : { sourceMap: r.guest.sourceMap }),
							...(assets === undefined
								? {}
								: {
										assets: Object.fromEntries(
											Object.entries(assets).map(([hash, text]) => [
												hash,
												new Uint8Array(Buffer.from(text, 'base64'))
											])
										)
									})
						}
					})
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
// Only schema bytes are shared. Every workspace still applies its current source rows and owns its database.
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
			yield* applyPlan(db, plan(yield* readApplied(db), slice), { accept: true });
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
		const key = JSON.stringify({
			dir: root === undefined ? null : join(root, '.norbital', 'cache', 'schema-images'),
			slice: { ...schemaSlice(manifest), connections: {} }
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
			try: () => import('../compiler/check/index.ts'),
			catch: invalid
		});
		const artifact = yield* Effect.tryPromise({
			try: () => import('../compiler/artifact/seed.ts'),
			catch: invalid
		});
		const errors: import('../compiler/check/index.ts').CheckDiagnostic[] = [],
			cache = join(root, '.norbital', 'cache');
		const pack = yield* compiler.seedPack(root, errors);
		yield* artifact.buildPacks(root, manifest, pack, join(cache, 'test-seed'), { cache }, errors);
		if (errors.length > 0)
			return yield* Effect.fail(
				new KitInvalid({
					message: `TestWorkspace: the base pack failed:\n${errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
				})
			);
		return yield* readPack(join(cache, 'test-seed', 'base'));
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

/** A native test workspace service; its layer owns database and engine resources in scope and exposes the same host routes used by deployed workspaces. */
export class TestWorkspace extends Context.Service<TestWorkspace, Kit>()(
	'@norbital-ai/bolt/test/TestWorkspace'
) {
	static readonly layer = <P extends TestPorts>(
		options: TestOptions<P>
	): Layer.Layer<TestWorkspace | WorkspaceServices, KitFailure> =>
		Layer.effectContext(
			Effect.gen(function* () {
				let { manifest, guest, transforms, projections } = options;
				const artifact = options.artifact;
				if (artifact !== undefined) ({ manifest, guest, transforms, projections } = artifact);
				const seed = options.seed ?? (options.root === undefined ? 'none' : 'base');
				if (options.root !== undefined) {
					const built = yield* checked(options.root);
					if (built.errors.length > 0 || built.manifest === undefined)
						return yield* Effect.fail(
							new KitInvalid({
								message: `bolt check failed:\n${built.errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`
							})
						);
					({ manifest, guest, transforms, projections } = built);
				}
				if (manifest === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: 'TestWorkspace takes a root or a manifest' })
					);
				if (typeof seed === 'string' && seed !== 'none' && options.root === undefined)
					return yield* Effect.fail(
						new KitInvalid({ message: `TestWorkspace: seed '${seed}' needs a root` })
					);
				const m = layered(manifest),
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
							if (
								crashing !== null &&
								/UPDATE sys_run s SET state = \$/.test(statement.text) &&
								JSON.stringify(statement.params).includes(crashing)
							) {
								crashing = null;
								crashed = true;
								return yield* Effect.fail(
									new DbError({
										message: 'crash: the host died before the run recorded its end',
										sqlstate: '08006'
									})
								);
							}
							count.writes++;
							return yield* inner.write(statement, lock);
						}),
					transaction: (body, lock) => Effect.andThen(flush, inner.transaction(body, lock))
				});
				let now = options.now ?? '2026-09-25T10:00:00.000Z';
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
				const f: Fakes = {
					files: { blobs: new Map() },
					deadlines: { announced: [] },
					sent: [],
					links: {
						sent: [],
						typed: [],
						answer: (instance) => Port.unavailable('link', `'${instance}' has no link`),
						page: (instance) => Port.unavailable('link', `'${instance}' has no link`)
					}
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
								typing: (instance, to) =>
									Effect.sync(() => {
										f.links.typed.push({ instance, to });
									}),
								request: (instance, op) => f.links.answer(instance, op),
								read: (instance, feed, partition, cursor) =>
									f.links.page(instance, feed, partition, cursor),
								changed: () => Effect.void
							});
				const ports = Layer.mergeAll(
					files,
					links,
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
					NodeCrypto.layer,
					Layer.succeed(EnvoyConfig, envoyConfig ?? {}),
					Layer.effect(AgentHost, withBrowser(agentConfig ?? {})).pipe(Layer.provide(hostPorts)),
					hostPorts,
					Layer.succeed(TenantDb, db),
					Layer.succeed(Clock.Clock, clock),
					Layer.succeed(GuestConfig, { cpu: options.cpu }),
					Layer.succeed(Activation, {
						scope: 'test',
						epoch: '',
						release: artifact?.artifact.hash ?? 'test',
						publicUrl,
						guest: Option.fromNullishOr(guest),
						transforms: new Set(transforms),
						projections: new Set(projections),
						start: [],
						secretsKey: Option.fromNullishOr(options.secretsKey)
					})
				);
				yield* applyPlan(db, plan(yield* readApplied(db), m), { accept: true });
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
						.loadPackWithAssets(db, m, pack, Context.get(portContext, Files), now)
						.pipe(Effect.provide(node));
				} else if (typeof seed === 'object' && Object.keys(seed).length > 0) {
					if (IDENTITY.some((collection) => seed[collection] !== undefined)) {
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
						yield* loadPack(db, m, pack, now);
					} else yield* restore(m, db, seed, now);
				}
				const engineContext = yield* Layer.build(EngineLive(m).pipe(Layer.provideMerge(base)));
				const runs = Context.get(engineContext, Runs),
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
						workspace: { name: 'Test', handle: 'test' },
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
										publicPages(artifact).pipe(
											Layer.provide(Layer.succeedContext(hostContext)),
											Layer.provide(NodeFileSystem.layer)
										)
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
					Effect.tryPromise({ try: () => response.json(), catch: invalid });
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
				function storedRead<C extends string>(
					collection: Is<C, ReadableName>,
					query: DeclaredQuery
				): Effect.Effect<Page<DeclaredRow<C>>, ReadFailed>;
				function storedRead<
					C extends string,
					const S extends { readonly [P in WorkspaceReadField<C>]?: true } = {}
				>(
					collection: Is<C, ReadableName>,
					q: { where?: NoInfer<ModelWhere<C>>; select?: S } & Paged
				): Effect.Effect<StoredReadAnswer<C, S>>;
				function storedRead<const M extends ReadSet>(
					set: M & { readonly [K in keyof M]: StoredMember<M[K]['collection']> }
				): Effect.Effect<StoredSetAnswer<M>>;
				function storedRead(
					collection: string | ReadSet,
					q?: { readonly mode?: unknown; readonly select?: unknown }
				): Effect.Effect<unknown, ReadFailed> {
					const read = Effect.gen(function* () {
						const b = yield* bindings;
						if (typeof collection === 'string') {
							const args = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Json))(
								yield* wireJson([collection, q])
							);
							const ir = yield* Effect.try({
								try: () => lowerRead(m, 'db.read', args),
								catch: decodeFailure
							});
							const values = yield* storedReads.run([ir], { as: 'workspace' }, b);
							const value = values[0];
							if (value === undefined)
								return yield* Effect.fail(
									new ReadFailed({
										code: 'protocol',
										message: 'The host returned no stored read answer.'
									})
								);
							return yield* q?.mode === 'declared'
								? storedAnswer('storedDeclared', collection, value, q)
								: storedAnswer('storedRead', collection, value, q?.select);
						}
						const set = yield* Schema.decodeUnknownEffect(
							Schema.Record(Schema.String, Schema.Json)
						)(yield* wireJson(collection));
						const earlier = new Set<string>(),
							scope = randomUUID();
						const batch = yield* Effect.try({
							try: () =>
								Object.entries(set).map(([key, spec]) => {
									const ir = lowerKeyedMember(
										'db.read',
										key,
										spec,
										(method, args) => lowerRead(m, method, args),
										scope,
										earlier
									);
									earlier.add(key);
									return ir;
								}),
							catch: decodeFailure
						});
						const values = yield* storedReads.run(batch, { as: 'workspace' }, b);
						return yield* storedAnswer(
							'storedSet',
							'',
							Object.fromEntries(Object.keys(set).map((key, index) => [key, values[index]])),
							undefined,
							collection
						);
					});
					return (
						typeof collection === 'string' && q?.mode === 'declared'
							? read.pipe(Effect.mapError(readFailure))
							: read.pipe(Effect.orDie)
					).pipe(Effect.provide(hostContext));
				}
				const bodyActs: Kit['bodyActs'] = (who) => {
					const authority =
						'collections' in who ? who : compileAuthority(m, who, `test:${randomUUID()}`);
					return {
						many: (acts) =>
							Effect.gen(function* () {
								const input = yield* Schema.decodeUnknownEffect(
									Schema.Array(Schema.Struct({ callable: Schema.String, input: Schema.Json })),
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
									if (callable._tag !== 'Verb')
										return yield* Effect.fail(
											new ActRefused({
												code: 'invalidInput',
												message: 'act.many takes generated verbs'
											})
										);
									native.push({
										collection: callable.collection,
										verb: callable.verb,
										input: act.input
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
								if (outcome.kind === 'pendingApproval')
									return yield* Effect.fail(
										new ActRefused({
											code: 'pendingApproval',
											message: 'The batch is held for approval.',
											data: { requestId: outcome.requestId }
										})
									);
								return yield* answer('many', 'act.many', outcome, undefined, undefined, input).pipe(
									Effect.orDie
								);
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
							if (reply.outcome.kind === 'pendingApproval') return reply.outcome;
							if (reply.outcome.kind === 'committed') return reply.outcome;
							return yield* Effect.die(reply.outcome);
						}).pipe(Effect.catchTag('KitInvalid', Effect.die));
					const readError = (error: { readonly message: string }) =>
						new ReadFailed({ code: 'protocol', message: error.message });
					function callerRead<C extends string>(
						collection: Is<C, ReadableName>,
						query: DeclaredQuery
					): Effect.Effect<Page<DeclaredRow<C>>, ReadFailed>;
					function callerRead<C extends string, const S extends Select<C> = {}>(
						collection: Is<C, ReadableName>,
						q: {
							where?: NoInfer<Where<C>>;
							select?: S;
							orderBy?: NoInfer<OrderBy<C>>;
							search?: string;
						} & Paged
					): Effect.Effect<Page<ListResult<C, S>>, ReadFailed>;
					function callerRead<const M extends ReadSet>(
						set: M & { readonly [K in keyof M]: ReadMember<M[K]['collection']> }
					): Effect.Effect<ReadSetAnswer<M>, ReadFailed>;
					function callerRead(
						collection: string | ReadSet,
						q?: { readonly mode?: unknown; readonly select?: unknown }
					): Effect.Effect<unknown, ReadFailed> {
						return typeof collection === 'string'
							? read('read', [collection, q]).pipe(
									Effect.flatMap((value) =>
										(q?.mode === 'declared'
											? answer('declared', collection, value, q)
											: answer('read', collection, value, q?.select)
										).pipe(Effect.mapError(readError))
									)
								)
							: read('read', [collection]).pipe(
									Effect.flatMap((value) =>
										answer('set', '', value, undefined, collection).pipe(Effect.mapError(readError))
									)
								);
					}
					return {
						authority,
						act: <const N extends string>(
							name: Is<N, KitCallable>,
							input: NoInfer<KitInput<N>>,
							opts?: ActOptions
						) =>
							act(String(name), input, opts).pipe(
								Effect.flatMap((value) =>
									answer<'act', N>('act', String(name), value, undefined, undefined, input).pipe(
										Effect.orDie
									)
								)
							),
						query: <const N extends string>(
							name: Is<N, QueryCallable>,
							input: NoInfer<QueryInput<N>>
						) => {
							const callable = String(name),
								dot = callable.lastIndexOf('.');
							return read('query', [callable.slice(0, dot), callable.slice(dot + 1), input]).pipe(
								Effect.flatMap((value) =>
									answer<'query', N>('query', callable, value).pipe(Effect.mapError(readError))
								)
							);
						},
						start: (name, input, opts) =>
							act('start', {
								automation: name,
								input,
								id: opts?.id ?? uuidv7(Date.parse(now))
							}).pipe(Effect.flatMap((value) => answer('start', '', value).pipe(Effect.orDie))),
						read: callerRead,
						get: <C extends string, const S extends Select<C> = {}>(
							name: Is<C, ReadableName>,
							id: NoInfer<Id<C>>,
							q?: { select?: S; revision?: number }
						) =>
							read('get', [name, id, q ?? {}]).pipe(
								Effect.flatMap((value) =>
									answer<'get', C, S>('get', String(name), value, q?.select).pipe(
										Effect.mapError(readError)
									)
								)
							),
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
				const kit: Kit = {
					manifest: m,
					release: artifact?.artifact.hash ?? 'test',
					db,
					storedRead,
					bodyActs,
					fakes,
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
						caller('collections' in who ? who : compileAuthority(m, who, `test:${randomUUID()}`)),
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
					runDue: () => runs.tick.pipe(Effect.provide(hostContext)),
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
