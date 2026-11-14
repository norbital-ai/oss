// Port calls (L-BOLT-288, 289): every host port call runs under its wall, and a port's throw or bad answer is a typed
// facility failure, never a throw. `Port.fromPromise` is for Promise ports across an ABI (providers and host services).
import { Duration, Effect, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { FACILITY_KINDS, FacilityFailure, Unavailable, type PortFailure } from './errors.ts';

/** A `FacilityError` value a port threw (a provider refusal carries its kind). */
const Thrown = Schema.Union([
	Schema.Struct({
		kind: Schema.Literals(FACILITY_KINDS),
		message: Schema.String,
		status: Schema.optional(Schema.Number),
		retry_after_ms: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
	}),
	Schema.Struct({
		kind: Schema.Literal('unavailable'),
		facility: Schema.String,
		reason: Schema.String
	})
]);
const thrown = Schema.decodeUnknownOption(Thrown);

/**
 * A port's throw or rejection as its failure: a thrown `FacilityError` keeps its kind; anything else is `upstream`, keeping
 * its message (an `Error`'s, or an encoded host refusal's such as Studio's `HostFailure`).
 */
const failureOf =
	(facility: string) =>
	(e: unknown): PortFailure =>
		Option.match(thrown(e), {
			onNone: () =>
				new FacilityFailure({
					kind: 'upstream',
					message:
						Predicate.hasProperty(e, 'message') && Predicate.isString(e.message) && e.message !== ''
							? e.message
							: `${facility} failed`
				}),
			onSome: (f) =>
				f.kind === 'unavailable'
					? new Unavailable({ facility: f.facility, reason: f.reason })
					: new FacilityFailure(f)
		});

/** Helpers that run host port calls under a wall and turn a port's throw or bad answer into a typed `PortFailure`. */
export const Port = {
	/** Bounds one port call by its wall: past `wallMs` the call is interrupted and fails `timeout`. */
	call:
		(facility: string, wallMs: number, message = `${facility} did not answer within ${wallMs} ms`) =>
		<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | FacilityFailure, R> =>
			Effect.timeoutOrElse(self, {
				duration: Duration.millis(wallMs),
				orElse: () =>
					Effect.fail(
						new FacilityFailure({
							kind: 'timeout',
							message
						})
					)
			}),
	/**
	 * A Promise port call: interruption aborts `signal`; a throw is the call's failure (`failureOf`); the answer is
	 * decoded, and one that is not `decode`'s is `upstream`.
	 */
	fromPromise: <A, RD>(
		f: (signal: AbortSignal) => PromiseLike<unknown>,
		decode: Schema.Decoder<A, RD>,
		facility = 'the port'
	): Effect.Effect<A, PortFailure, RD> =>
		Effect.tryPromise({ try: (signal) => f(signal), catch: failureOf(facility) }).pipe(
			Effect.flatMap((answer) => Schema.decodeUnknownEffect(decode)(answer)),
			Effect.mapError((e) =>
				Schema.isSchemaError(e)
					? new FacilityFailure({
							kind: 'upstream',
							message: `${facility} answered something that is not its result`
						})
					: e
			)
		),
	/** A typed host Promise ABI call: `fromPromise` without a decode, since its type is the port's. */
	attempt: <A>(
		facility: string,
		f: (signal: AbortSignal) => PromiseLike<A>
	): Effect.Effect<A, PortFailure> =>
		Effect.tryPromise({ try: (signal) => f(signal), catch: failureOf(facility) }),
	/** A port's throw as its failure, for a caller with its own catch (a driver's `SendRefused`). */
	failure: failureOf,
	/** The failure of a port the host does not provide. */
	unavailable: (
		facility: string,
		reason = `the host provides no ${facility}`
	): Effect.Effect<never, Unavailable> => Effect.fail(new Unavailable({ facility, reason }))
};

/** A host's runner (`FiberSet.makeRuntimePromise`): runs an Effect to a Promise, interrupted when `signal` aborts. */
export type Run = <A, E>(
	effect: Effect.Effect<A, E>,
	options?: { readonly signal?: AbortSignal | undefined }
) => Promise<A>;

/** The caller's HTTP client, else fetch (the caller's `fetch` when given). */
export type HttpOptions = { http_client?: HttpClient.HttpClient; fetch?: typeof fetch };
/** Provides an adapter's HTTP client: `options.http_client`, else fetch. */
export const provide_http =
	(options: HttpOptions) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const provided =
			options.http_client === undefined
				? effect.pipe(Effect.provide(FetchHttpClient.layer))
				: effect.pipe(Effect.provideService(HttpClient.HttpClient, options.http_client));
		return options.http_client === undefined && options.fetch !== undefined
			? provided.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))
			: provided;
	};
