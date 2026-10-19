// The driver ABI, the engine's side (D10b). A provider is the host's, from another module graph, so a link stays the
// Promise + AbortSignal + JSON contract of `driver.ts`. `openLink` and `linkCalls` are the one adapter: every call is an
// Effect whose interruption aborts the provider's signal; an answer is decoded, a rejection keeps its fence or becomes
// a facility failure (a send's refusal its `SendRefused`), and a missing operation fails `Unavailable`.
// Unpair's optional provider cleanup ends locally when the provider has no remote sign-out operation.
import { Effect, FiberSet, Option, Schema, type Scope } from 'effect';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import type { Json } from '../../decl/values.ts';
import type { OutboundFile } from '../services.ts';
import { SendRefused, sendRefusal } from '../conversations/status.ts';
import { Port, type PortFailure } from '../port.ts';
import { Fenced } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { DriverOpen, Link, Provider } from './driver.ts';

/** What a send answers: the provider's message id, and how long until bolt presumes it delivered without a report. */
const SendReceipt = Schema.Struct({
	providerId: Schema.String,
	presumeAfterMs: Schema.optionalKey(Schema.Number)
});
/** A pushing driver's feed page (`DriverPage`). */
const DriverPageSchema = Schema.Struct({
	items: Schema.Array(Schema.Json),
	cursor: Schema.Json,
	more: Schema.Boolean,
	snapshot: Schema.optionalKey(Schema.Literals(['begin', 'end'])),
	retained: Schema.optionalKey(Schema.Literal(false)),
	health: Schema.optionalKey(
		Schema.Struct({
			state: Schema.Literals(['ready', 'attention']),
			code: Schema.optionalKey(Schema.String),
			message: Schema.optionalKey(Schema.String)
		})
	)
});
const Resources = Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }));

/** One instance's link as the engine calls it. */
export type LinkCalls = {
	readonly close: Effect.Effect<void, PortFailure>;
	readonly pair: (input: Json) => Effect.Effect<void, PortFailure | Fenced | BoltError>;
	readonly unpair: Effect.Effect<void, PortFailure>;
	readonly test: (input: Json) => Effect.Effect<void, PortFailure>;
	readonly send: (
		message: Json,
		attachments?: readonly OutboundFile[]
	) => Effect.Effect<typeof SendReceipt.Type, PortFailure | SendRefused | Fenced>;
	readonly typing: (to: string) => Effect.Effect<void, PortFailure>;
	readonly request: (op: Json) => Effect.Effect<Json, PortFailure | Fenced>;
	readonly read: (
		feed: string,
		partition: string,
		cursor: Json | null
	) => Effect.Effect<typeof DriverPageSchema.Type, PortFailure>;
	readonly discover: Effect.Effect<typeof Resources.Type, PortFailure>;
	readonly renew: Effect.Effect<string | null, PortFailure>;
	readonly webhook: (request: Request) => Effect.Effect<Response, PortFailure>;
};

const absent = (member: string) =>
	Port.unavailable(`link.${member}`, `this link's provider has no ${member}`);
const decodeLinkFailure = Schema.decodeUnknownOption(
	Schema.Union([Fenced, FacilityFailure, Unavailable])
);
const decodeBoltError = Schema.decodeUnknownOption(BoltError);
const decodePairingInvalid = Schema.decodeUnknownOption(
	Schema.TaggedStruct('PairingInvalid', { message: Schema.String })
);
/** A lost credential epoch remains terminal across the provider's Promise boundary. */
export const linkFailure =
	(instance: string) =>
	(error: unknown): PortFailure | Fenced => {
		const failure = decodeLinkFailure(error);
		if (Option.isSome(failure)) return failure.value;
		const bolt = decodeBoltError(error);
		return Option.isSome(bolt) && bolt.value.code === 'fenced'
			? new Fenced({ instance, message: bolt.value.message })
			: Port.failure('link')(error);
	};
/** A send's rejection keeps the provider's refusal, its fence, or the facility failure. */
const refusedOr =
	(instance: string) =>
	(e: unknown): PortFailure | SendRefused | Fenced => {
		const r = sendRefusal(e);
		return r === null ? linkFailure(instance)(e) : new SendRefused(r.message, r.code, r.permanent);
	};
const receipt = (answer: unknown) =>
	Schema.decodeUnknownEffect(SendReceipt)(answer).pipe(
		Effect.mapError(
			() =>
				new FacilityFailure({
					kind: 'upstream',
					message: 'link answered something that is not its result'
				})
		)
	);

/** `link`'s members as Effects; each member is called on the link itself. */
type UrlRunner = (effect: Effect.Effect<string, PortFailure>) => Promise<string>;
export function linkCalls(link: Link, run: UrlRunner, instance: string): LinkCalls {
	const pair = link.pair?.bind(link),
		unpair = link.unpair?.bind(link),
		test = link.test?.bind(link),
		send = link.send?.bind(link),
		typing = link.typing?.bind(link),
		request = link.request?.bind(link),
		read = link.read?.bind(link),
		discover = link.discover?.bind(link),
		renew = link.renew?.bind(link),
		webhook = link.webhook?.bind(link);
	return {
		close: Port.attempt('link', () => link.close()),
		pair:
			pair === undefined
				? () => absent('pair')
				: (input) =>
						Effect.tryPromise({
							try: () => pair(input),
							catch: (error) =>
								Option.match(decodePairingInvalid(error), {
									onSome: (failure) => BoltError.make('invalidInput', 'admission', failure.message),
									onNone: () => linkFailure(instance)(error)
								})
						}),
		unpair: unpair === undefined ? Effect.void : Port.attempt('link', () => unpair()),
		test:
			test === undefined
				? () => absent('test')
				: (input) => Port.attempt('link', () => test(input)),
		send:
			send === undefined
				? () => absent('send')
				: (message, attachments) =>
						Effect.tryPromise({
							try: (signal) =>
								send(
									message,
									signal,
									attachments?.map(({ url, ...file }) => ({
										...file,
										url: (expiresInS: number) =>
											run(
												url === undefined
													? Effect.fail(
															new Unavailable({
																facility: 'files.url',
																reason: 'this file store has no signed URLs'
															})
														)
													: url(expiresInS)
											)
									}))
								),
							catch: refusedOr(instance)
						}).pipe(Effect.flatMap(receipt)),
		typing:
			typing === undefined
				? () => absent('typing')
				: (to) => Port.attempt('link', (signal) => typing(to, signal)),
		request:
			request === undefined
				? () => absent('request')
				: (op) =>
						Effect.tryPromise({
							try: (signal) => request(op, signal),
							catch: linkFailure(instance)
						}).pipe(
							Effect.flatMap((answer) =>
								Schema.decodeUnknownEffect(Schema.Json)(answer).pipe(
									Effect.mapError(
										() =>
											new FacilityFailure({
												kind: 'upstream',
												message: 'link answered something that is not its result'
											})
									)
								)
							)
						),
		read:
			read === undefined
				? () => absent('read')
				: (feed, partition, cursor) =>
						Port.fromPromise(
							(signal) => read(feed, partition, cursor, signal),
							DriverPageSchema,
							'link'
						),
		discover:
			discover === undefined
				? absent('discover')
				: Port.fromPromise(() => discover(), Resources, 'link'),
		renew:
			renew === undefined
				? absent('renew')
				: Port.fromPromise(() => renew(), Schema.NullOr(Schema.String), 'link'),
		webhook:
			webhook === undefined
				? () => absent('webhook')
				: (r) => Port.attempt('link', () => webhook(r))
	};
}

/**
 * Opens `provider`'s link for one instance in the current scope: `DriverOpen.signal` is the scope's, and closing the
 * scope closes the link (a failed close is logged; the scope still ends).
 */
export const openLink = (
	provider: Provider,
	ctx: Omit<DriverOpen, 'signal'>
): Effect.Effect<LinkCalls, PortFailure, Scope.Scope> =>
	Effect.gen(function* () {
		const signal = yield* Effect.abortSignal;
		const run = yield* FiberSet.makeRuntimePromise<never>();
		const calls = linkCalls(
			yield* Port.attempt('link', () => provider.open({ ...ctx, signal })),
			run,
			ctx.instance
		);
		yield* Effect.addFinalizer(() =>
			calls.close.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		);
		return calls;
	});
