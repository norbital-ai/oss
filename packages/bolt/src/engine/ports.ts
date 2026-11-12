// Host ports as services (D4, B.1; P18, P19): what the engine asks of its host, by capability, never by provider.
// Every member fails typed — the facility's failure or `Unavailable`. A port is required; one the host may leave out
// takes `off` explicitly (`@norbital-ai/bolt/facilities`), and only then answers `Unavailable`. Walls are the caller's
// (`Port.call`). The tenant database is `TenantDb` (`db/tenant-db.ts`).
import {
	ByteSize,
	Context,
	Effect,
	FiberSet,
	FileSystem,
	Layer,
	Match,
	Option,
	Path,
	PlatformError,
	Queue,
	Schema,
	Stream,
	type Scope
} from 'effect';
import { IngestedSchema } from './media.ts';
import { BrowserSnapshotSchema, type BrowserSnapshot } from '../decl/runtime/browser.ts';
import { LIMITS } from './contracts.ts';
import { Unavailable } from '../decl/errors.ts';
import type { SendReceipt } from './conversations/status.ts';
import type {
	ConvertSource,
	ConvertTarget,
	GeoHit,
	IngestOptions,
	WebPage
} from '../decl/runtime/facilities.ts';
import type { Json, Point } from '../decl/values.ts';
import type {
	DocsPort,
	AiModel,
	AiPort,
	AiRequest,
	AiResponse,
	ArtifactPort,
	ArtifactStat,
	Blob,
	Bundled,
	BundlerPort,
	BundleRequest,
	BrowserPort,
	BrowserCaller,
	BrowserStep,
	BrowserTarget,
	BrowserWorkspaceTarget,
	ConvertPort,
	DeadlinesPort,
	Downloaded,
	DriverPage,
	EmbedInput,
	EmbeddingsPort,
	FilesPort,
	GeocoderPort,
	GuestAnswers,
	GuestIsolatesPort,
	GuestSessionOptions,
	GuestStart,
	GuestTurn,
	HttpFetchOptions,
	HttpPort,
	HttpRequest,
	HttpResponse,
	ImageMetadata,
	ImageCrop,
	ImagePreview,
	ImagePreviewMime,
	ImagePreviewSize,
	ImagesPort,
	Ingested,
	IngestPort,
	KeysPort,
	LinksPort,
	LogEvent,
	LogPort,
	LogQuery,
	LogRow,
	McpPort,
	McpServer,
	McpToolInfo,
	TransportPort,
	WebReadPort
} from './contracts.ts';
import { SendRefused, sendRefusal } from './conversations/status.ts';
import type { DecisionResult, System1Request } from './decision.ts';
import type { OutboundFile } from './services.ts';
import type { Fenced } from './errors.ts';
import type { GuestProgram } from './guest/runner.ts';
import { BoltError, CODES } from '../protocol/errors.ts';
import { linkFailure } from './integrations/abi.ts';
import { Port, type PortFailure } from './port.ts';
import { corpus, type DocsCorpus } from './docs-corpus.ts';
import { GuestTurnSchema } from './guest/schema.ts';
import { AiPortResponseSchema } from './ai-schema.ts';
import { is_off, type Off } from '../facilities/off.ts';

/** Adapt typed ABI methods whose last argument is the interruption signal. */
const lift =
	<Args extends readonly unknown[], A>(
		facility: string,
		call: (...args: [...Args, AbortSignal]) => PromiseLike<A>
	) =>
	(...args: Args): Effect.Effect<A, PortFailure> =>
		Port.attempt(facility, (signal) => call(...args, signal));

const turnedOff = (facility: string) =>
	Port.unavailable(facility, 'the host turned this facility off');

// ── files ──
/** Stored blobs; the `sys_file` row is the engine's (rule 18). `get` answers at most `max` bytes (more is `invalid`). */
export class Files extends Context.Service<
	Files,
	{
		readonly put: (
			bytes: Uint8Array,
			meta: { readonly name: string; readonly mime: string }
		) => Effect.Effect<Blob, PortFailure>;
		readonly get: (key: string, max: number) => Effect.Effect<Uint8Array, PortFailure>;
		readonly url: (key: string, expiresInS: number) => Effect.Effect<string, PortFailure>;
		readonly remove: (key: string) => Effect.Effect<void, PortFailure>;
		/** The host fetches a public media URL and stores it (`FilesPort.download`); no bytes cross. */
		readonly download: (url: string) => Effect.Effect<Downloaded, PortFailure>;
	}
>()('bolt/Files') {
	static fromAbi(port: FilesPort): Layer.Layer<Files> {
		return Layer.succeed(Files, {
			put: lift('files', port.put.bind(port)),
			get: lift('files', port.get.bind(port)),
			url: lift('files', port.url.bind(port)),
			remove: lift('files', port.remove.bind(port)),
			download: lift('files', port.download.bind(port))
		});
	}
}

// ── convert ──
/** `reference` is the bytes of a styling document (docx, pptx, odt). */
export type ConvertSettings = Parameters<ConvertPort['convert']>[2];

const IngestAnswered = Schema.Union([
	IngestedSchema,
	Schema.Struct({ unsupported: Schema.String })
]);
/**
 * The document converter behind `ctx.convert.document`; `targets` is what this host serves (none when unavailable).
 * `ingest` (the agent's `read_file`, `ctx.convert.ingest`) is absent when the host has no ingest port.
 */
export class Convert extends Context.Service<
	Convert,
	{
		readonly targets: readonly ConvertTarget[];
		readonly convert: (
			source: ConvertSource,
			to: ConvertTarget,
			options: ConvertSettings
		) => Effect.Effect<Uint8Array, PortFailure>;
		readonly previewPdf?: (
			source: ConvertSource,
			options: Pick<ConvertSettings, 'page' | 'landscape'>
		) => Effect.Effect<Uint8Array, PortFailure>;
		readonly ingest?: (
			file: {
				readonly sha256: string;
				readonly name: string;
				readonly mime: string;
				readonly bytes?: Uint8Array;
				readonly key?: string;
			},
			options: Omit<IngestOptions, 'for'>
		) => Effect.Effect<Ingested | { readonly unsupported: string }, PortFailure>;
	}
>()('bolt/Convert') {
	static fromAbi(port: ConvertPort | Off, ingester?: IngestPort['ingest']): Layer.Layer<Convert> {
		const previewPdf = is_off(port) ? undefined : port.preview_pdf;
		return Layer.succeed(Convert, {
			...(is_off(port)
				? { targets: [], convert: () => turnedOff('convert') }
				: {
						targets: port.targets,
						convert: lift('convert', port.convert.bind(port)),
						...(previewPdf === undefined
							? {}
							: {
									previewPdf: lift('convert', previewPdf.bind(port))
								})
					}),
			...(ingester === undefined
				? {}
				: {
						ingest: (file, options) =>
							Port.fromPromise(
								(signal) => ingester(file, options, signal),
								IngestAnswered,
								'convert.ingest'
							)
					})
		});
	}
}

// ── web, geo ──
/** Reads a public page; refuses private, loopback and link-local addresses. `raw` also answers the markup and its links. */
export class WebRead extends Context.Service<
	WebRead,
	{
		readonly read: (
			url: string,
			options?: { readonly raw?: boolean }
		) => Effect.Effect<WebPage, PortFailure>;
	}
>()('bolt/WebRead') {
	static fromAbi(port: WebReadPort | Off): Layer.Layer<WebRead> {
		return is_off(port)
			? Layer.succeed(WebRead, { read: () => turnedOff('web') })
			: Layer.succeed(WebRead, {
					read: (url, options) => Port.attempt('web', (signal) => port.read(url, signal, options))
				});
	}
}
/** A browser tab as a scoped resource: close it when the scope ends, never leave it to an idle timer alone. */
export type BrowserSession = {
	readonly navigate: (to: BrowserTarget, find?: string) => Effect.Effect<BrowserSnapshot, PortFailure>;
	readonly snapshot: (options: {
		readonly find?: string;
		readonly from?: number;
	}) => Effect.Effect<BrowserSnapshot, PortFailure>;
	readonly act: (steps: readonly BrowserStep[]) => Effect.Effect<BrowserSnapshot, PortFailure>;
	readonly evaluate: (expression: string) => Effect.Effect<Json, PortFailure>;
	readonly screenshot: () => Effect.Effect<Uint8Array, PortFailure>;
	readonly download: (url: string) => Effect.Effect<Downloaded, PortFailure>;
};
/** The browsing facility (`BrowserPort`); a host that turns it off fails each call as unavailable. */
export class Browser extends Context.Service<
	Browser,
	{
		readonly navigate: (
			profile: string,
			to: BrowserTarget,
			find?: string
		) => Effect.Effect<BrowserSnapshot, PortFailure>;
		/** A page of the workspace as the person, signed in by the host's hand-off; absent when the host cannot sign in. */
		readonly openWorkspace?: (
			profile: string,
			target: BrowserWorkspaceTarget,
			caller: BrowserCaller
		) => Effect.Effect<BrowserSnapshot, PortFailure>;
		/** Close this tab now; the profile's sealed sign-ins stay for its next open. */
		readonly close: (profile: string) => Effect.Effect<void, PortFailure>;
		/** A tab whose finalizer closes it: the one way a run or a caller keeps browser hygiene. */
		readonly scoped: (profile: string) => Effect.Effect<BrowserSession, PortFailure, Scope.Scope>;
		readonly snapshot: (
			profile: string,
			options: { readonly find?: string; readonly from?: number }
		) => Effect.Effect<BrowserSnapshot, PortFailure>;
		readonly act: (
			profile: string,
			steps: readonly BrowserStep[]
		) => Effect.Effect<BrowserSnapshot, PortFailure>;
		readonly evaluate: (profile: string, expression: string) => Effect.Effect<Json, PortFailure>;
		readonly screenshot: (profile: string) => Effect.Effect<Uint8Array, PortFailure>;
		readonly download: (profile: string, url: string) => Effect.Effect<Downloaded, PortFailure>;
	}
>()('bolt/Browser') {
	static fromAbi(port: BrowserPort | Off): Layer.Layer<Browser> {
		if (is_off(port)) {
			const none = () => turnedOff('browser');
			return Layer.succeed(Browser, {
				navigate: none,
				snapshot: none,
				act: none,
				evaluate: none,
				screenshot: none,
				download: none,
				close: none,
				scoped: () =>
					Effect.acquireRelease(
						Effect.succeed({
							navigate: none,
							snapshot: none,
							act: none,
							evaluate: none,
							screenshot: none,
							download: none
						}),
						() => Effect.void
					)
			});
		}
		const openWorkspace = port.open_workspace?.bind(port),
			close = port.close.bind(port),
			snapshot = (read: (signal: AbortSignal) => PromiseLike<unknown>) =>
				Port.fromPromise(read, BrowserSnapshotSchema, 'browser'),
			shape = {
				navigate: (profile: string, to: BrowserTarget, find?: string) =>
					snapshot((signal) => port.navigate(profile, to, find, signal)),
				snapshot: (profile: string, options: { readonly find?: string; readonly from?: number }) =>
					snapshot((signal) => port.snapshot(profile, options, signal)),
				act: (profile: string, steps: readonly BrowserStep[]) =>
					snapshot((signal) => port.act(profile, steps, signal)),
				evaluate: lift('browser', port.evaluate.bind(port)),
				screenshot: lift('browser', port.screenshot.bind(port)),
				download: lift('browser', port.download.bind(port)),
				close: (profile: string) => Port.attempt('browser', (signal) => close(profile, signal)).pipe(
					Port.call('browser.close', LIMITS.callMs.http), Effect.asVoid
				)
			};
		return Layer.succeed(Browser, {
			...shape,
			...(openWorkspace === undefined
				? {}
				: {
						openWorkspace: (profile: string, target: BrowserWorkspaceTarget, caller: BrowserCaller) =>
							snapshot((signal) => openWorkspace(profile, target, caller, signal))
					}),
			scoped: (profile) => {
				const session: BrowserSession = {
					navigate: (to, find) => shape.navigate(profile, to, find),
					snapshot: (options) => shape.snapshot(profile, options),
					act: (steps) => shape.act(profile, steps),
					evaluate: (expression) => shape.evaluate(profile, expression),
					screenshot: () => shape.screenshot(profile),
					download: (url) => shape.download(profile, url)
				};
				return Effect.acquireRelease(Effect.succeed(session), () => shape.close(profile).pipe(
					Effect.tapError((error) => Effect.logWarning('Browser.close_failed', error)), Effect.ignore
				)).pipe(
					Effect.tap(() => Port.attempt('browser', (signal) => port.open(profile, signal)).pipe(
						Port.call('browser', LIMITS.callMs.http)
					))
				);
			}
		});
	}
}
export class Geo extends Context.Service<
	Geo,
	{
		readonly search: (query: string) => Effect.Effect<readonly GeoHit[], PortFailure>;
		readonly reverse: (point: Point) => Effect.Effect<GeoHit | null, PortFailure>;
	}
>()('bolt/Geo') {
	static fromAbi(port: GeocoderPort | Off): Layer.Layer<Geo> {
		return is_off(port)
			? Layer.succeed(Geo, { search: () => turnedOff('geo'), reverse: () => turnedOff('geo') })
			: Layer.succeed(Geo, {
					search: lift('geo', port.search.bind(port)),
					reverse: lift('geo', port.reverse.bind(port))
				});
	}
}
/** The runtime log (§5.12), held by the host: `write` never waits or fails. */
export type LogsShape = {
	readonly write: (event: LogEvent) => Effect.Effect<void>;
	readonly query: (query: LogQuery) => Effect.Effect<readonly LogRow[], PortFailure>;
};
export class Logs extends Context.Service<Logs, LogsShape>()('bolt/Logs') {
	static fromAbi(port: LogPort): Layer.Layer<Logs> {
		return Layer.succeed(Logs, {
			write: (event) =>
				Effect.try({ try: () => port.write(event), catch: (error) => error }).pipe(Effect.ignore),
			query: lift('logs', port.query.bind(port))
		});
	}
}
// ── transport ──
/** A transactional email (a sign-in code, an invitation); `link` is the invitation's. */
export type MailMessage = {
	readonly _tag: 'Mail';
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
	readonly link?: string;
};
/** A transactional text message. */
export type SmsMessage = { readonly _tag: 'Sms'; readonly to: string; readonly text: string };
/**
 * One inbox notice to one device (`bolt.push`): the host routes it by `subscription.kind` (web push or APNs), signs it
 * and sends `{ id, title, body, path }`, `path` the workspace URL the notice opens.
 */
export type PushMessage = {
	readonly _tag: 'Push';
	/** The durable inbox notice identity, retained when an uncertain delivery is retried. */
	readonly id: string;
	readonly subscription: {
		readonly kind: 'web' | 'apns';
		readonly endpoint: string;
		readonly keys: Json;
	};
	readonly title: string;
	readonly body: string | null;
	readonly link: { readonly model: string; readonly id: string } | null;
	readonly path: string;
};
export type TransportMessage = MailMessage | SmsMessage | PushMessage;
/** The transport ABI send kind and the facility a failure names, per message. */
const TRANSPORT: {
	readonly [T in TransportMessage['_tag']]: { readonly kind: string; readonly facility: string };
} = {
	Mail: { kind: 'email', facility: 'email' },
	Sms: { kind: 'sms', facility: 'sms' },
	Push: { kind: 'inbox', facility: 'push' }
};
/** The host's own messaging: a send to an address. */
export class Transport extends Context.Service<
	Transport,
	{
		readonly send: (
			message: TransportMessage
		) => Effect.Effect<{ readonly provider_id: string }, PortFailure>;
	}
>()('bolt/Transport') {
	/** Mail is mandatory; SMS and push may be `off`. */
	static fromAbi(ports: {
		readonly Mail: TransportPort;
		readonly Sms: TransportPort | Off;
		readonly Push: TransportPort | Off;
	}): Layer.Layer<Transport> {
		return Layer.succeed(Transport, {
			send: (m) => {
				const port = ports[m._tag],
					{ kind, facility } = TRANSPORT[m._tag];
				return is_off(port)
					? turnedOff(facility)
					: Port.attempt(facility, (signal) => port.send(kind, messageBody(m), signal));
			}
		});
	}
}
/** A transport ABI message body: its fields without the tag, absent ones left out. */
const messageBody = (m: TransportMessage): Json =>
	Match.valueTags(m, {
		Mail: (x): Json =>
			Object.fromEntries(
				Object.entries({
					to: x.to,
					subject: x.subject,
					text: x.text,
					html: x.html,
					link: x.link
				}).filter((e): e is [string, string] => e[1] !== undefined)
			),
		Sms: (x): Json => ({ to: x.to, text: x.text }),
		Push: (x): Json => ({
			id: x.id,
			subscription: x.subscription,
			title: x.title,
			body: x.body,
			link: x.link,
			path: x.path
		})
	});

// ── deadlines ──
/** One next-due instant per scope, held in host memory; no polling (rule 52a). */
export class DeadlinePort extends Context.Service<
	DeadlinePort,
	{
		readonly announce: (scope: string, notLaterThan: string) => Effect.Effect<void, PortFailure>;
		readonly settle: (scope: string, nextDue: string | null) => Effect.Effect<void, PortFailure>;
		readonly teardown: (scope: string) => Effect.Effect<void, PortFailure>;
	}
>()('bolt/DeadlinePort') {
	static fromAbi(port: DeadlinesPort): Layer.Layer<DeadlinePort> {
		return Layer.succeed(DeadlinePort, {
			announce: (scope, notLaterThan) =>
				Port.attempt('deadlines', () => port.announce(scope, notLaterThan)),
			settle: (scope, nextDue) => Port.attempt('deadlines', () => port.settle(scope, nextDue)),
			teardown: (scope) => Port.attempt('deadlines', () => port.teardown(scope))
		});
	}
}

// ── run units ──
/**
 * The kernel's meter, told as each run starts: the run begins the next unit of its wake, with a CPU budget of its own.
 * Without a host meter, a wake is one unit.
 */
export const RunUnits = Context.Reference<{
	readonly next: () => Effect.Effect<void>;
}>('bolt/RunUnits', { defaultValue: () => ({ next: () => Effect.void }) });

// ── drivers ──
/**
 * The live links' driver calls, by instance (§4.5): a conversation driver sends (a provider refusal is `SendRefused`,
 * permanent or retried) and shows typing, a request driver answers `request` with the instance's credential host-side, a
 * pushing driver (a calendar) reads a page of items for a sync; `changed` reopens a link from its row as it is now.
 */
export class Drivers extends Context.Service<
	Drivers,
	{
		/** Whether this environment binds live integration drivers. */
		readonly available: boolean;
		readonly send: (
			instance: string,
			message: Json,
			attachments?: readonly OutboundFile[]
		) => Effect.Effect<
			SendReceipt,
			PortFailure | SendRefused | Fenced
		>;
		readonly typing: (
			instance: string,
			to: string,
			on: boolean
		) => Effect.Effect<void, PortFailure>;
		/** A fake remote: it has no provider for a definition's `rate` to protect, and a test's clock would never wake the wait. */
		readonly unpaced?: true;
		readonly request: (instance: string, op: Json) => Effect.Effect<Json, PortFailure | Fenced>;
		readonly read: (
			instance: string,
			sync: string,
			partition: string,
			cursor: Json | null
		) => Effect.Effect<DriverPage, PortFailure>;
		readonly changed: (instance: string) => Effect.Effect<void, Unavailable>;
	}
>()('bolt/Drivers') {
	/** `off`: this environment binds no live integration drivers. */
	static fromAbi(links: LinksPort | Off): Layer.Layer<Drivers> {
		const port = is_off(links) ? undefined : links;
		const send = port?.send?.bind(port),
			typing = port?.typing?.bind(port),
			request = port?.request?.bind(port),
			read = port?.read?.bind(port),
			changed = port?.changed?.bind(port);
		return Layer.effect(
			Drivers,
			Effect.gen(function* () {
				const run = yield* FiberSet.makeRuntimePromise();
				return Drivers.of({
					available: port !== undefined,
					send:
						send === undefined
							? () => Port.unavailable('link')
							: (instance, message, attachments) =>
									Effect.tryPromise({
										try: (signal) =>
											send(
												instance,
												message,
												signal,
												attachments?.map(({ url, ...file }) => ({
													...file,
													url: (expiresInS: number) =>
														run(
															url === undefined
																? Port.unavailable(
																		'files.url',
																		'this file store has no signed URLs'
																	)
																: url(expiresInS)
														)
												}))
											),
										catch: (e) => {
											const r = sendRefusal(e);
											return r === null
												? linkFailure(instance)(e)
												: new SendRefused(r.message, r.code, r.permanent);
										}
									}),
					typing:
						typing === undefined
							? () => Port.unavailable('link')
							: (instance, to, on) =>
									Port.attempt('link', (signal) => typing(instance, to, signal, on)),
					request:
						request === undefined
							? () => Port.unavailable('link')
							: (instance, op) =>
									Effect.tryPromise({
										try: (signal) => request(instance, op, signal),
										catch: linkFailure(instance)
									}),
					read: read === undefined ? () => Port.unavailable('link') : lift('link', read),
					changed:
						changed === undefined
							? () => Port.unavailable('link')
							: (instance) => Effect.sync(() => changed(instance))
				});
			})
		);
	}
}

// ── ai ──
/** One `sys_2` call as it streams: text as it arrives, progress that is not text (a tool call's arguments, reasoning), then the response. */
export type AiEvent =
	| { readonly _tag: 'Delta'; readonly text: string }
	| { readonly _tag: 'Progress'; readonly reasoning: string | undefined }
	| { readonly _tag: 'Response'; readonly response: AiResponse };
/**
 * The AI facility (P35, P39): `ask` is `sys_1` (structured decisions from text and resolved images), `infer` the `sys_2` LLM
 * (multimodal; the 20 s idle wall cuts a stream into a `cut` step, rule 63), `embed` the embedding model. `models` are the
 * classes the host maps; `catalog` the concrete models a person may pick and the one a conversation starts on.
 */
export class Ai extends Context.Service<
	Ai,
	{
		readonly ask: (request: System1Request) => Effect.Effect<DecisionResult, PortFailure>;
		readonly maxChoices: number | undefined;
		readonly models: readonly string[];
		readonly catalog: Effect.Effect<
			{ readonly models: readonly AiModel[]; readonly default: string },
			PortFailure
		>;
		readonly infer: (request: AiRequest) => Stream.Stream<AiEvent, PortFailure>;
		readonly embed: (
			inputs: readonly EmbedInput[],
			model: string,
			dimensions?: number
		) => Effect.Effect<readonly (readonly number[])[], PortFailure>;
	}
>()('bolt/Ai') {
	private static readonly noSystem1: Ai['Service']['ask'] = () => turnedOff('ai');
	/** Whether the host bound a decision function; provider failures do not change capability presence. */
	static hasSystem1(service: Ai['Service']): boolean {
		return service.ask !== Ai.noSystem1;
	}
	/** The intelligence group: each member the host's, or `off`. */
	static fromAbi(ports: {
		readonly system1: AiPort['sys_1'] | Off;
		readonly system2: AiPort['sys_2'] | Off;
		readonly embed: EmbeddingsPort | Off;
	}): Layer.Layer<Ai> {
		const sys1 = is_off(ports.system1) ? undefined : ports.system1,
			sys2 = is_off(ports.system2) ? undefined : ports.system2,
			embed = is_off(ports.embed) ? undefined : ports.embed;
		const catalog = sys2?.catalog?.bind(sys2);
		return Layer.succeed(Ai, {
			ask: sys1 === undefined ? Ai.noSystem1 : lift('sys_1', sys1.ask.bind(sys1)),
			maxChoices: sys1?.max_choices,
			models: sys2?.models ?? [],
			catalog: catalog === undefined ? turnedOff('ai') : Port.attempt('ai', () => catalog()),
			infer:
				sys2 === undefined
					? () =>
							Stream.fail(
								new Unavailable({ facility: 'ai', reason: 'the host turned this facility off' })
							)
					: (request) =>
							Stream.callback<AiEvent, PortFailure>((queue) =>
								Port.attempt('ai', (signal) =>
									sys2.infer(
										request,
										signal,
										(text) => {
											Queue.offerUnsafe(queue, { _tag: 'Delta', text });
										},
										(reasoning) => {
											Queue.offerUnsafe(queue, { _tag: 'Progress', reasoning });
										}
									)
								).pipe(
									Effect.flatMap((response) => Schema.decodeUnknownEffect(AiPortResponseSchema)(response).pipe(Effect.mapError(Port.failure('ai')))),
									Effect.flatMap((response) => Queue.offer(queue, { _tag: 'Response', response })),
									Effect.andThen(Queue.end(queue)),
									Effect.catch((e) => Queue.fail(queue, e))
								)
							),
			embed:
				embed === undefined
					? () => turnedOff('ai.embed')
					: (inputs, model, dimensions) =>
							Port.attempt('ai.embed', (signal) => embed.embed(inputs, model, signal, dimensions))
		});
	}
}

// ── kernel ports (compute model §14, wave 1) ──
/** The release's files, read-only (`ArtifactPort`): the engine's `FileSystem` is built over it. */
export class ArtifactFiles extends Context.Service<
	ArtifactFiles,
	{
		readonly read: (path: string) => Effect.Effect<Uint8Array, PortFailure>;
		readonly list: (dir: string) => Effect.Effect<readonly string[], PortFailure>;
		readonly stat: (path: string) => Effect.Effect<ArtifactStat | null, PortFailure>;
	}
>()('bolt/ArtifactFiles') {
	static fromAbi(port: ArtifactPort): Layer.Layer<ArtifactFiles> {
		return Layer.succeed(ArtifactFiles, {
			read: lift('artifact', port.read.bind(port)),
			list: lift('artifact', port.list.bind(port)),
			stat: lift('artifact', port.stat.bind(port))
		});
	}
	/**
	 * The engine's `FileSystem` and `Path` over the release: `''` is its root, reads only. The host resolves symlinks
	 * and refuses paths outside the release and its seed packs, so `realPath` is the identity.
	 */
	static fileSystem(port: ArtifactPort): Layer.Layer<FileSystem.FileSystem | Path.Path> {
		return Layer.effect(
			FileSystem.FileSystem,
			Effect.gen(function* () {
				const files = yield* ArtifactFiles,
					path = yield* Path.Path;
				const clean = (at: string) => {
					const normal = path.normalize(at).replace(/\/+$/, '');
					return normal === '.' ? '' : normal;
				};
				const failed = (method: string, at: string) => (cause: PortFailure) =>
					PlatformError.systemError({
						_tag: 'Unknown',
						module: 'FileSystem',
						method,
						pathOrDescriptor: at,
						cause
					});
				const stat = (at: string) =>
					files.stat(clean(at)).pipe(Effect.mapError(failed('stat', at)));
				const readFile = (at: string) =>
					files.read(clean(at)).pipe(Effect.mapError(failed('readFile', at)));
				const fileInfo = (at: string) =>
					Effect.flatMap(stat(at), (info) =>
						info === null
							? Effect.fail(
									PlatformError.systemError({
										_tag: 'NotFound',
										module: 'FileSystem',
										method: 'stat',
										pathOrDescriptor: at
									})
								)
							: Effect.succeed({
									type: info.kind === 'file' ? 'File' : 'Directory',
									mtime: Option.none(),
									atime: Option.none(),
									birthtime: Option.none(),
									dev: 0n,
									ino: Option.none(),
									mode: 0o444,
									nlink: Option.none(),
									uid: Option.none(),
									gid: Option.none(),
									rdev: Option.none(),
									size: ByteSize.bytes(info.size),
									blksize: Option.none(),
									blocks: Option.none()
								} satisfies FileSystem.File.Info)
					);
				return FileSystem.makeNoop({
					readFile,
					readFileString: (at, encoding) =>
						Effect.flatMap(readFile(at), (bytes) =>
							Effect.try({
								try: () => new TextDecoder(encoding).decode(bytes),
								catch: (cause) =>
									PlatformError.badArgument({
										module: 'FileSystem',
										method: 'readFileString',
										description: 'invalid encoding',
										cause
									})
							})
						),
					exists: (at) => Effect.map(stat(at), (info) => info !== null),
					realPath: (at) => Effect.succeed(clean(at)),
					stat: fileInfo,
					// the store holds no links: a path's own info is its target's
					lstat: fileInfo,
					// `list` is recursive; one level is its distinct first segments
					readDirectory: (at, options) =>
						files.list(clean(at)).pipe(
							Effect.mapError(failed('readDirectory', at)),
							Effect.map((names) =>
								options?.recursive === true
									? [...names]
									: [...new Set(names.map((name) => name.split('/')[0] ?? name))]
							)
						)
				});
			})
		).pipe(Layer.provide(ArtifactFiles.fromAbi(port)), Layer.provideMerge(Path.layer));
	}
}

/**
 * The tenant's secrets key, held by the host (`KeysPort`): `open` is `None` for an envelope that does not open under
 * this key and `aad`. Without a key nothing seals or opens, and `available` is false.
 */
export class Keys extends Context.Service<
	Keys,
	{
		readonly seal: (plain: Uint8Array, aad: Uint8Array) => Effect.Effect<Uint8Array, PortFailure>;
		readonly open: (
			sealed: Uint8Array,
			aad: Uint8Array
		) => Effect.Effect<Option.Option<Uint8Array>, PortFailure>;
	}
>()('bolt/Keys') {
	static fromAbi(port: KeysPort): Layer.Layer<Keys> {
		return Layer.succeed(Keys, {
			seal: lift('keys', port.seal.bind(port)),
			open: (sealed, aad) =>
				Port.attempt('keys', (signal) => port.open(sealed, aad, signal)).pipe(
					Effect.map(Option.fromNullOr)
				)
		});
	}
}

// The turn comes from a tenant-controlled isolate through the host untouched: it is decoded here, once.
const decodeTurn = Schema.decodeUnknownEffect(GuestTurnSchema);
const decodeHostFailure = Schema.decodeUnknownOption(
	Schema.Struct({
		_tag: Schema.Literal('HostFailure'),
		code: Schema.Literals(CODES),
		message: Schema.String
	})
);
/** A session's rejection: the host's encoded code (`cpu_budget`, `memory`) as the guest's failure, else `internal`. */
const guestFailure = (error: unknown): BoltError =>
	Option.match(decodeHostFailure(error), {
		onSome: (f) => BoltError.make(f.code, 'guest', f.message),
		onNone: () => BoltError.make('internal', 'guest', 'the guest isolate failed', error)
	});
/** One open guest session: each member is one native slice answering its turn. */
export type GuestSession = {
	readonly start: (start: GuestStart) => Effect.Effect<GuestTurn, BoltError>;
	readonly take: Effect.Effect<GuestTurn, BoltError>;
	readonly give: (answers: GuestAnswers) => Effect.Effect<GuestTurn, BoltError>;
};
/** Guest isolates, made and metered by the host (`GuestIsolatesPort`); a session is disposed with its scope. */
export class GuestIsolates extends Context.Service<
	GuestIsolates,
	{
		readonly open: (
			program: GuestProgram,
			options: GuestSessionOptions
		) => Effect.Effect<GuestSession, BoltError, Scope.Scope>;
	}
>()('bolt/GuestIsolates') {
	static fromAbi(port: GuestIsolatesPort): Layer.Layer<GuestIsolates> {
		const slice = (f: (signal: AbortSignal) => Promise<GuestTurn>) =>
			Effect.tryPromise({ try: f, catch: guestFailure }).pipe(
				Effect.flatMap((turn) =>
					decodeTurn(turn).pipe(
						Effect.mapError((error) => BoltError.make('invalid_input', 'guest', error.message))
					)
				)
			);
		return Layer.succeed(GuestIsolates, {
			open: (program, options) =>
				Effect.acquireRelease(
					Effect.tryPromise({
						try: (signal) => port.open(program, options, signal),
						catch: guestFailure
					}),
					(session) =>
						Port.attempt('guest', () => port.close(session)).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						),
					{ interruptible: true }
				).pipe(
					Effect.map((session): GuestSession => ({
						start: (start) => slice((signal) => port.start(session, start, signal)),
						take: slice((signal) => port.take(session, signal)),
						give: (answers) => slice((signal) => port.give(session, answers, signal))
					}))
				)
		});
	}
}

/** Outbound HTTP under the public-network policy (`HttpPort`); the wall is the caller's. */
export class Http extends Context.Service<
	Http,
	{
		readonly fetch: (
			request: HttpRequest,
			options: HttpFetchOptions
		) => Effect.Effect<HttpResponse, PortFailure>;
	}
>()('bolt/Http') {
	static fromAbi(port: HttpPort | Off): Layer.Layer<Http> {
		return is_off(port)
			? Layer.succeed(Http, { fetch: () => turnedOff('http') })
			: Layer.succeed(Http, {
					fetch: lift('http', port.fetch.bind(port))
				});
	}
}

/**
 * The confined bundler for file runs (`BundlerPort`). Unlike the other ports it is optional: the agent runs files only
 * where a host provides it. The wall is the caller's.
 */
export class Bundler extends Context.Service<
	Bundler,
	{ readonly bundle: (request: BundleRequest) => Effect.Effect<Bundled, PortFailure> }
>()('bolt/Bundler') {
	static fromAbi(port: BundlerPort): Layer.Layer<Bundler> {
		return Layer.succeed(Bundler, {
			bundle: lift('bundler', port.bundle.bind(port))
		});
	}
}

/** Image decoding off the engine (`ImagesPort`): facts, a bounded JPEG, a preview. */
export class Images extends Context.Service<
	Images,
	{
		readonly facts: (bytes: Uint8Array) => Effect.Effect<ImageMetadata, PortFailure>;
		readonly jpeg: (bytes: Uint8Array, maxEdge: number) => Effect.Effect<Uint8Array, PortFailure>;
		readonly crop: (bytes: Uint8Array, box: ImageCrop) => Effect.Effect<Uint8Array, PortFailure>;
		readonly preview: (
			bytes: Uint8Array,
			mime: ImagePreviewMime,
			maxEdge: ImagePreviewSize
		) => Effect.Effect<ImagePreview, PortFailure>;
	}
>()('bolt/Images') {
	static fromAbi(port: ImagesPort): Layer.Layer<Images> {
		return Layer.succeed(Images, {
			facts: lift('files.image', port.facts.bind(port)),
			jpeg: lift('files.image', port.jpeg.bind(port)),
			crop: lift('files.image', port.crop.bind(port)),
			preview: lift('files.image', port.preview.bind(port))
		});
	}
}

/** One connected MCP server's session; closed with its scope. */
export type McpSession = {
	readonly tools: Effect.Effect<readonly McpToolInfo[], PortFailure>;
	readonly call: (tool: string, input: Json) => Effect.Effect<Json, PortFailure>;
};
/** MCP over streamable HTTP (`McpPort`), the server resolved by the engine; the wall is the caller's. */
export class Mcp extends Context.Service<
	Mcp,
	{
		readonly connect: (server: McpServer) => Effect.Effect<McpSession, PortFailure, Scope.Scope>;
	}
>()('bolt/Mcp') {
	static fromAbi(port: McpPort | Off): Layer.Layer<Mcp> {
		return is_off(port)
			? Layer.succeed(Mcp, { connect: () => turnedOff('mcp') })
			: Layer.succeed(Mcp, {
					connect: (server) =>
						Effect.acquireRelease(
							Port.attempt('mcp', (signal) => port.connect(server, signal)),
							(session) =>
								Port.attempt('mcp.close', () => port.close(session)).pipe(
									Effect.tapCause(Effect.logWarning),
									Effect.ignore
								),
							{ interruptible: true }
						).pipe(
							Effect.map((session): McpSession => ({
								tools: Port.attempt('mcp', (signal) => port.tools(session, signal)),
								call: (tool, input) =>
									Port.attempt('mcp', (signal) => port.call(session, tool, input, signal))
							}))
						)
				});
	}
}
/**
 * The release's docs corpus for the agent's `docs` tool, loaded from the host once per activation on first use: the
 * index, then every namespace and skill it lists.
 */
export class Docs extends Context.Service<
	Docs,
	{ readonly corpus: Effect.Effect<DocsCorpus, PortFailure> }
>()('bolt/Docs') {
	static fromAbi(port: DocsPort): Layer.Layer<Docs> {
		const read = (file: string) =>
			Port.attempt('docs', (signal) => port.read(file, signal)).pipe(
				Effect.flatMap((text) =>
					Effect.try({
						try: (): unknown => JSON.parse(text),
						catch: Port.failure('docs')
					})
				)
			);
		return Layer.effect(
			Docs,
			Effect.map(
				Effect.cached(corpus(read)),
				(loaded) => ({ corpus: loaded })
			)
		);
	}
}
