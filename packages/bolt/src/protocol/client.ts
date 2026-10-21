// Browser transport: one HttpClient path, decoding and reviving at the HTTP boundary.
import { Duration, Effect, Schema, SubscriptionRef } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ProtocolFailed, TransportFailed } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';

/** A release cutover holds the host's admission closed for seconds; requests wait it out up to this budget. */
const BUSY_BUDGET_MILLIS = 60_000;
const BusyRefusal = Schema.Struct({ error: Schema.Struct({ code: Schema.Literal('busy') }) });
/** Requests now waiting out a cutover; the shell shows one "Updating" notice while it is positive. */
export const updating = Effect.runSync(SubscriptionRef.make(0));

export function browserTransport(options: {
	base?: string;
	fetch?: typeof fetch;
	httpClient?: HttpClient.HttpClient;
}) {
	const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const once = (request: HttpClientRequest.HttpClientRequest) =>
		Effect.gen(function* () {
			const response = yield* HttpClient.execute(request);
			const retryAfter = Number(response.headers['retry-after']);
			if (response.status === 204) return { status: response.status, body: null, retryAfter };
			const text = yield* response.text;
			const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
				Effect.mapError(() => new TransportFailed({ status: response.status })),
				Effect.catch((error) =>
					response.status >= 400 ? Effect.succeed(null) : Effect.fail(error)
				)
			);
			return { status: response.status, body, retryAfter };
		}).pipe(
			Effect.mapError((error) =>
				error instanceof ProtocolFailed || error instanceof TransportFailed
					? error
					: new TransportFailed({ status: 0 })
			),
			options.httpClient === undefined
				? Effect.provide(FetchHttpClient.layer)
				: Effect.provideService(HttpClient.HttpClient, options.httpClient),
			Effect.provideService(FetchHttpClient.Fetch, send),
			Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'same-origin' })
		);
	type Reply = Effect.Success<ReturnType<typeof once>>;
	type Failure = Effect.Error<ReturnType<typeof once>>;
	// Busy is the host's admission refusal: the request never ran, so the same request (and idempotency key) is resent.
	const waitAfter = (reply: Reply) =>
		reply.status === 503 && reply.retryAfter > 0 && Schema.is(BusyRefusal)(reply.body)
			? reply.retryAfter * 1000
			: null;
	const retried = (
		request: HttpClientRequest.HttpClientRequest,
		reply: Reply,
		left: number
	): Effect.Effect<Reply, Failure> => {
		const wait = waitAfter(reply);
		return wait === null || wait > left
			? Effect.succeed(reply)
			: Effect.sleep(Duration.millis(wait)).pipe(
					Effect.andThen(once(request)),
					Effect.flatMap((next) => retried(request, next, left - wait))
				);
	};
	const execute = (request: HttpClientRequest.HttpClientRequest) =>
		once(request).pipe(
			Effect.flatMap((reply) =>
				waitAfter(reply) === null
					? Effect.succeed(reply)
					: Effect.acquireUseRelease(
							SubscriptionRef.update(updating, (n) => n + 1),
							() => retried(request, reply, BUSY_BUDGET_MILLIS),
							() => SubscriptionRef.update(updating, (n) => n - 1)
						)
			),
			Effect.map(({ status, body }) => ({ status, body }))
		);
	const request = (
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: Json,
		headers: Readonly<Record<string, string>> = {}
	) => {
		const req = HttpClientRequest.make(method)(`${options.base ?? ''}${path}`, { headers });
		return execute(body === undefined ? req : HttpClientRequest.bodyJsonUnsafe(req, body));
	};
	const upload = (path: string, file: Blob, headers: Readonly<Record<string, string>>) =>
		Effect.tryPromise({
			try: () => file.arrayBuffer(),
			catch: () => new TransportFailed({ status: 0 })
		}).pipe(
			Effect.flatMap((bytes) =>
				execute(
					HttpClientRequest.put(`${options.base ?? ''}${path}`, { headers }).pipe(
						HttpClientRequest.bodyUint8Array(
							new Uint8Array(bytes),
							file.type || 'application/octet-stream'
						)
					)
				)
			)
		);
	return { request, upload };
}
