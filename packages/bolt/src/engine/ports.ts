// Host ports as services (D4, B.1; P18, P19): what the engine asks of its host, by capability, never by provider.
// Every member fails typed — the facility's failure or `Unavailable` — and every service has `unavailable`, the layer
// a host without that capability provides (no optional ports). Walls are the caller's (`Port.call`). The tenant
// database is `TenantDb` (`db/tenant-db.ts`).
import { Context, Effect, FiberSet, Layer, Match, Queue, Schema, Stream } from 'effect';
import { Unavailable } from '../decl/errors.ts';
import type {
	ConvertTarget,
	GeoHit,
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	WebPage
} from '../decl/runtime/facilities.ts';
import type { Json, Point } from '../decl/values.ts';
import type {
	AiModel,
	AiPort,
	AiRequest,
	AiResponse,
	Blob,
	BrowserPort,
	BrowserFile,
	BrowserStep,
	BrowserTarget,
	ConvertPort,
	DeadlinesPort,
	DriverPage,
	EmbedInput,
	EmbeddingsPort,
	FilesPort,
	GeocoderPort,
	LinksPort,
	MeteringPort,
	SpeechPort,
	TransportPort,
	WebReadPort
} from './contracts.ts';
import { SendRefused, sendRefusal } from './conversations/status.ts';
import type { DecisionResult, System1Request } from './decisions/index.ts';
import type { OutboundFile } from './services.ts';
import type { Fenced } from './errors.ts';
import { linkFailure } from './integrations/abi.ts';
import { Port, type PortFailure } from './port.ts';

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
	}
>()('bolt/Files') {
	static readonly unavailable: Layer.Layer<Files> = Layer.succeed(Files, {
		put: () => Port.unavailable('files'),
		get: () => Port.unavailable('files'),
		url: () => Port.unavailable('files'),
		remove: () => Port.unavailable('files')
	});
	static fromAbi(port: FilesPort | undefined): Layer.Layer<Files> {
		return port === undefined
			? Files.unavailable
			: Layer.succeed(Files, {
					put: (bytes, meta) => Port.attempt('files', (signal) => port.put(bytes, meta, signal)),
					get: (key, max) => Port.attempt('files', (signal) => port.get(key, max, signal)),
					url: (key, expiresInS) =>
						Port.attempt('files', (signal) => port.url(key, expiresInS, signal)),
					remove: (key) => Port.attempt('files', (signal) => port.remove(key, signal))
				});
	}
}

// ── convert ──
/** `reference` is the bytes of a styling document (docx, pptx, odt). */
export type ConvertOptions = {
	readonly reference?: Uint8Array;
	readonly page?: 'A4' | 'A3' | 'Letter';
	readonly landscape?: boolean;
};
/** The document converter behind `ctx.convert.document`; `targets` is what this host serves (none when unavailable). */
export class Convert extends Context.Service<
	Convert,
	{
		readonly targets: readonly ConvertTarget[];
		readonly convert: (
			source: { readonly markdown: string } | { readonly html: string },
			to: ConvertTarget,
			options: ConvertOptions
		) => Effect.Effect<Uint8Array, PortFailure>;
	}
>()('bolt/Convert') {
	static readonly unavailable: Layer.Layer<Convert> = Layer.succeed(Convert, {
		targets: [],
		convert: () => Port.unavailable('convert')
	});
	static fromAbi(port: ConvertPort | undefined): Layer.Layer<Convert> {
		return port === undefined
			? Convert.unavailable
			: Layer.succeed(Convert, {
					targets: port.targets,
					convert: (source, to, options) =>
						Port.attempt('convert', (signal) => port.convert(source, to, options, signal))
				});
	}
}

// ── speech ──
const TranscriptAnswer = Schema.Struct({
	segments: Schema.Array(
		Schema.Struct({
			speaker: Schema.String,
			start: Schema.Number,
			end: Schema.Number,
			text: Schema.String
		})
	),
	language: Schema.NullOr(Schema.String),
	durationMs: Schema.Number
});
const SpeechAnswer = Schema.Struct({ bytes: Schema.Uint8Array, mime: Schema.String });
/** Speech behind `ctx.ai.transcribe` and `ctx.ai.speak`; a provider refusal keeps its kind (`rateLimited`, `tooLarge`, …). */
export class Speech extends Context.Service<
	Speech,
	{
		readonly transcribe: (
			audio: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array },
			options: TranscribeOptions
		) => Effect.Effect<Transcript, PortFailure>;
		readonly speak: (
			text: string,
			options: {
				readonly voice?: string;
				readonly format: SpeechFormat;
				readonly language?: string;
			}
		) => Effect.Effect<{ readonly bytes: Uint8Array; readonly mime: string }, PortFailure>;
	}
>()('bolt/Speech') {
	static readonly unavailable: Layer.Layer<Speech> = Layer.succeed(Speech, {
		transcribe: () => Port.unavailable('ai.transcribe', 'the host provides no transcription'),
		speak: () => Port.unavailable('ai.speak', 'the host provides no speech')
	});
	static fromAbi(port: SpeechPort | undefined): Layer.Layer<Speech> {
		const transcribe = port?.transcribe?.bind(port),
			speak = port?.speak?.bind(port);
		return Layer.succeed(Speech, {
			transcribe:
				transcribe === undefined
					? () => Port.unavailable('ai.transcribe', 'the host provides no transcription')
					: (audio, options) =>
							Port.fromPromise(
								(signal) => transcribe(audio, options, signal),
								TranscriptAnswer,
								'ai.transcribe'
							),
			speak:
				speak === undefined
					? () => Port.unavailable('ai.speak', 'the host provides no speech')
					: (text, options) =>
							Port.fromPromise((signal) => speak(text, options, signal), SpeechAnswer, 'ai.speak')
		});
	}
}

// ── web, geo, metering ──
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
	static readonly unavailable: Layer.Layer<WebRead> = Layer.succeed(WebRead, {
		read: () => Port.unavailable('web')
	});
	static fromAbi(port: WebReadPort | undefined): Layer.Layer<WebRead> {
		return port === undefined
			? WebRead.unavailable
			: Layer.succeed(WebRead, {
					read: (url, options) => Port.attempt('web', (signal) => port.read(url, signal, options))
				});
	}
}
/** The browsing facility (`BrowserPort`); a host that supplies none fails each call as unavailable. */
export class Browser extends Context.Service<
	Browser,
	{
		readonly navigate: (
			profile: string,
			to: BrowserTarget,
			find?: string
		) => Effect.Effect<Json, PortFailure>;
		readonly snapshot: (
			profile: string,
			options: { readonly find?: string; readonly from?: number }
		) => Effect.Effect<Json, PortFailure>;
		readonly act: (
			profile: string,
			steps: readonly BrowserStep[]
		) => Effect.Effect<Json, PortFailure>;
		readonly evaluate: (profile: string, expression: string) => Effect.Effect<Json, PortFailure>;
		readonly screenshot: (profile: string) => Effect.Effect<Uint8Array, PortFailure>;
		readonly download: (profile: string, url: string) => Effect.Effect<BrowserFile, PortFailure>;
	}
>()('bolt/Browser') {
	static readonly unavailable: Layer.Layer<Browser> = Layer.sync(Browser, () => {
		const none = () => Port.unavailable('browser', 'the host provides no browser facility');
		return {
			navigate: none,
			snapshot: none,
			act: none,
			evaluate: none,
			screenshot: none,
			download: none
		};
	});
	static fromAbi(port: BrowserPort | undefined): Layer.Layer<Browser> {
		return port === undefined
			? Browser.unavailable
			: Layer.succeed(Browser, {
					navigate: (profile, to, find) =>
						Port.attempt('browser', (signal) => port.navigate(profile, to, find, signal)),
					snapshot: (profile, options) =>
						Port.attempt('browser', (signal) => port.snapshot(profile, options, signal)),
					act: (profile, steps) =>
						Port.attempt('browser', (signal) => port.act(profile, steps, signal)),
					evaluate: (profile, expression) =>
						Port.attempt('browser', (signal) => port.evaluate(profile, expression, signal)),
					screenshot: (profile) =>
						Port.attempt('browser', (signal) => port.screenshot(profile, signal)),
					download: (profile, url) =>
						Port.attempt('browser', (signal) => port.download(profile, url, signal))
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
	static readonly unavailable: Layer.Layer<Geo> = Layer.succeed(Geo, {
		search: () => Port.unavailable('geo'),
		reverse: () => Port.unavailable('geo')
	});
	static fromAbi(port: GeocoderPort | undefined): Layer.Layer<Geo> {
		return port === undefined
			? Geo.unavailable
			: Layer.succeed(Geo, {
					search: (query) => Port.attempt('geo', (signal) => port.search(query, signal)),
					reverse: (point) => Port.attempt('geo', (signal) => port.reverse(point, signal))
				});
	}
}
/** Usage the host bills: `quantity` of `meter`, once per `key`. */
export class Metering extends Context.Service<
	Metering,
	{
		readonly record: (
			meter: string,
			quantity: number,
			key: string
		) => Effect.Effect<void, PortFailure>;
	}
>()('bolt/Metering') {
	static readonly unavailable: Layer.Layer<Metering> = Layer.succeed(Metering, {
		record: () => Port.unavailable('metering')
	});
	static fromAbi(port: MeteringPort | undefined): Layer.Layer<Metering> {
		return port === undefined
			? Metering.unavailable
			: Layer.succeed(Metering, {
					record: (meter, quantity, key) =>
						Port.attempt('metering', () => port.record(meter, quantity, key))
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
 * and sends `{ title, body, path }`, `path` the workspace URL the notice opens.
 */
export type PushMessage = {
	readonly _tag: 'Push';
	readonly subscription: {
		readonly kind: 'web' | 'apns';
		readonly endpoint: string;
		readonly keys: Json;
	};
	readonly title: string;
	readonly body: string | null;
	readonly link: { readonly collection: string; readonly id: string } | null;
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
		) => Effect.Effect<{ readonly providerId: string }, PortFailure>;
	}
>()('bolt/Transport') {
	static readonly unavailable: Layer.Layer<Transport> = Layer.succeed(Transport, {
		send: (m) => Port.unavailable(TRANSPORT[m._tag].facility)
	});
	static fromAbi(ports: {
		readonly [T in TransportMessage['_tag']]?: TransportPort | undefined;
	}): Layer.Layer<Transport> {
		return Layer.succeed(Transport, {
			send: (m) => {
				const port = ports[m._tag],
					{ kind, facility } = TRANSPORT[m._tag];
				return port === undefined
					? Port.unavailable(facility)
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
		readonly announce: (scope: string, notLaterThan: string) => Effect.Effect<void, Unavailable>;
		readonly settle: (scope: string, nextDue: string | null) => Effect.Effect<void, Unavailable>;
		readonly teardown: (scope: string) => Effect.Effect<void, Unavailable>;
	}
>()('bolt/DeadlinePort') {
	static readonly unavailable: Layer.Layer<DeadlinePort> = Layer.succeed(DeadlinePort, {
		announce: () => Port.unavailable('deadlines'),
		settle: () => Port.unavailable('deadlines'),
		teardown: () => Port.unavailable('deadlines')
	});
	static fromAbi(port: DeadlinesPort | undefined): Layer.Layer<DeadlinePort> {
		return port === undefined
			? DeadlinePort.unavailable
			: Layer.succeed(DeadlinePort, {
					announce: (scope, notLaterThan) => Effect.sync(() => port.announce(scope, notLaterThan)),
					settle: (scope, nextDue) => Effect.sync(() => port.settle(scope, nextDue)),
					teardown: (scope) => Effect.sync(() => port.teardown(scope))
				});
	}
}

// ── drivers ──
/**
 * The live links' driver calls, by instance (§4.5): a conversation driver sends (a provider refusal is `SendRefused`,
 * permanent or retried) and shows typing, a request driver answers `request` with the instance's credential host-side, a
 * pushing driver reads a feed page; `changed` reopens a link from its row as it is now.
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
			{ providerId: string; presumeAfterMs?: number },
			PortFailure | SendRefused | Fenced
		>;
		readonly typing: (instance: string, to: string) => Effect.Effect<void, PortFailure>;
		readonly request: (instance: string, op: Json) => Effect.Effect<Json, PortFailure | Fenced>;
		readonly read: (
			instance: string,
			feed: string,
			partition: string,
			cursor: Json | null
		) => Effect.Effect<DriverPage, PortFailure>;
		readonly changed: (instance: string) => Effect.Effect<void, Unavailable>;
	}
>()('bolt/Drivers') {
	static readonly unavailable: Layer.Layer<Drivers> = Layer.succeed(Drivers, {
		available: false,
		send: () => Port.unavailable('link'),
		typing: () => Port.unavailable('link'),
		request: () => Port.unavailable('link'),
		read: () => Port.unavailable('link'),
		changed: () => Port.unavailable('link')
	});
	static fromAbi(port: LinksPort | undefined): Layer.Layer<Drivers> {
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
							: (instance, to) => Port.attempt('link', (signal) => typing(instance, to, signal)),
					request:
						request === undefined
							? () => Port.unavailable('link')
							: (instance, op) =>
									Effect.tryPromise({
										try: (signal) => request(instance, op, signal),
										catch: linkFailure(instance)
									}),
					read:
						read === undefined
							? () => Port.unavailable('link')
							: (instance, feed, partition, cursor) =>
									Port.attempt('link', (signal) => read(instance, feed, partition, cursor, signal)),
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
 * The AI facility (P35, P39): `ask` is `sys_1` (fast structured decisions, text only), `infer` the `sys_2` LLM
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
	private static readonly noSystem1: Ai['Service']['ask'] = () => Port.unavailable('ai');
	/** Whether the host bound a decision function; provider failures do not change capability presence. */
	static hasSystem1(service: Ai['Service']): boolean {
		return service.ask !== Ai.noSystem1;
	}
	static readonly unavailable: Layer.Layer<Ai> = Layer.succeed(Ai, {
		ask: Ai.noSystem1,
		maxChoices: undefined,
		models: [],
		catalog: Port.unavailable('ai'),
		infer: () =>
			Stream.fail(new Unavailable({ facility: 'ai', reason: 'the host provides no ai' })),
		embed: () => Port.unavailable('ai.embed', 'the host provides no embeddings')
	});
	static fromAbi(port: AiPort | EmbeddingsPort | undefined): Layer.Layer<Ai> {
		const ai = port !== undefined && 'sys_2' in port ? port : undefined,
			embed = port?.embed?.bind(port);
		const catalog = ai === undefined ? undefined : ai.sys_2.catalog?.bind(ai.sys_2);
		return Layer.succeed(Ai, {
			ask:
				ai === undefined
					? Ai.noSystem1
					: (request) => Port.attempt('sys_1', (signal) => ai.sys_1.ask(request, signal)),
			maxChoices: ai?.sys_1.maxChoices,
			models: ai?.sys_2.models ?? [],
			catalog: catalog === undefined ? Port.unavailable('ai') : Port.attempt('ai', () => catalog()),
			infer:
				ai === undefined
					? () =>
							Stream.fail(new Unavailable({ facility: 'ai', reason: 'the host provides no ai' }))
					: (request) =>
							Stream.callback<AiEvent, PortFailure>((queue) =>
								Port.attempt('ai', (signal) =>
									ai.sys_2.infer(
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
									Effect.flatMap((response) => Queue.offer(queue, { _tag: 'Response', response })),
									Effect.andThen(Queue.end(queue)),
									Effect.catch((e) => Queue.fail(queue, e))
								)
							),
			embed:
				embed === undefined
					? () => Port.unavailable('ai.embed', 'the host provides no embeddings')
					: (inputs, model, dimensions) =>
							Port.attempt('ai.embed', (signal) => embed(inputs, model, signal, dimensions))
		});
	}
}
