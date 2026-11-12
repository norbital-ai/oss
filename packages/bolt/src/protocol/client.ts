// Browser transport: one HttpClient path, decoding and reviving at the HTTP boundary.
import { Duration, Effect, Schema, SubscriptionRef } from 'effect';
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse
} from 'effect/http';
import { TransportFailed } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';

/** A release cutover holds the host's admission closed for seconds; requests wait it out up to this budget. */
const BUSY_BUDGET_MILLIS = 60_000;
const BusyRefusal = Schema.Struct({ error: Schema.Struct({ code: Schema.Literal('busy') }) });
/** Requests now waiting out a cutover; the shell shows one "Updating" notice while it is positive. */
export const updating = Effect.runSync(SubscriptionRef.make(0));

export function browserTransport(options: {
	base?: string;
	fetch?: typeof fetch;
	http_client?: HttpClient.HttpClient;
}) {
	const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const json = (response: HttpClientResponse.HttpClientResponse) =>
		Effect.gen(function* () {
			if (response.status === 204) return null;
			const text = yield* response.text;
			return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
				Effect.mapError(() => new TransportFailed({ status: response.status })),
				Effect.catch((error) =>
					response.status >= 400 ? Effect.succeed(null) : Effect.fail(error)
				)
			);
		});
	const pdf = (response: HttpClientResponse.HttpClientResponse) =>
		Effect.gen(function* () {
			if (response.status === 200 && response.headers['content-type'] === 'application/pdf')
				return new Uint8Array(yield* response.arrayBuffer);
			return yield* json(response);
		});
	const once = <A, E>(
		request: HttpClientRequest.HttpClientRequest,
		read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>
	) =>
		Effect.gen(function* () {
			const response = yield* HttpClient.execute(request);
			return {
				status: response.status,
				body: yield* read(response),
				retryAfter: Number(response.headers['retry-after'])
			};
		}).pipe(
			Effect.mapError((error) =>
				error instanceof TransportFailed ? error : new TransportFailed({ status: 0 })
			),
			options.http_client === undefined
				? Effect.provide(FetchHttpClient.layer)
				: Effect.provideService(HttpClient.HttpClient, options.http_client),
			Effect.provideService(FetchHttpClient.Fetch, send),
			Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'same-origin' })
		);
	type Reply<A> = { status: number; body: A; retryAfter: number };
	type Failure = Effect.Error<ReturnType<typeof once>>;
	// Busy is the host's admission refusal: the request never ran, so the same request (and idempotency key) is resent.
	const waitAfter = (reply: Reply<unknown>) =>
		reply.status === 503 && reply.retryAfter > 0 && Schema.is(BusyRefusal)(reply.body)
			? reply.retryAfter * 1000
			: null;
	const execute = <A, E>(
		request: HttpClientRequest.HttpClientRequest,
		read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>
	) => {
		const send = once(request, read);
		const retried = (reply: Reply<A>, left: number): Effect.Effect<Reply<A>, Failure> => {
			const wait = waitAfter(reply);
			return wait === null || wait > left
				? Effect.succeed(reply)
				: Effect.sleep(Duration.millis(wait)).pipe(
						Effect.andThen(send),
						Effect.flatMap((next) => retried(next, left - wait))
					);
		};
		return send.pipe(
			Effect.flatMap((reply) =>
				waitAfter(reply) === null
					? Effect.succeed(reply)
					: Effect.acquireUseRelease(
							SubscriptionRef.update(updating, (n) => n + 1),
							() => retried(reply, BUSY_BUDGET_MILLIS),
							() => SubscriptionRef.update(updating, (n) => n - 1)
						)
			),
			Effect.map(({ status, body }) => ({ status, body }))
		);
	};
	const request = (
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: Json,
		headers: Readonly<Record<string, string>> = {}
	) => {
		const req = HttpClientRequest.make(method)(`${options.base ?? ''}${path}`, { headers });
		return execute(body === undefined ? req : HttpClientRequest.bodyJsonUnsafe(req, body), json);
	};
	const requestPdf = (path: string, body: Json, headers: Readonly<Record<string, string>>) =>
		execute(
			HttpClientRequest.bodyJsonUnsafe(
				HttpClientRequest.post(`${options.base ?? ''}${path}`, { headers }),
				body
			),
			pdf
		);
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
					),
					json
				)
			)
		);
	return { request, requestPdf, upload };
}
