// Browser transport: one HttpClient path, decoding and reviving at the HTTP boundary.
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ProtocolFailed, TransportFailed } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';

export function browserTransport(options: {
	base?: string;
	fetch?: typeof fetch;
	httpClient?: HttpClient.HttpClient;
}) {
	const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const execute = (request: HttpClientRequest.HttpClientRequest) =>
		Effect.gen(function* () {
			const response = yield* HttpClient.execute(request);
			if (response.status === 204) return { status: response.status, body: null };
			const text = yield* response.text;
			const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
				Effect.mapError(() => new TransportFailed({ status: response.status })),
				Effect.catch((error) =>
					response.status >= 400 ? Effect.succeed(null) : Effect.fail(error)
				)
			);
			return { status: response.status, body };
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
