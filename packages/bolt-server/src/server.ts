import {
	BundleResult,
	EffectId,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	TransportRequest,
	type FacilityBindings,
	type RealtimeOutput
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, ManagedRuntime, Result, Schema } from 'effect';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { BundleLoader } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { ServerHealth } from './health.js';

/** Identifies a bounded Node transport operation that could not complete safely; stupidity:allow Q4 -- Effect TaggedError declaration is the canonical rc.109 error boundary. */
export class ServerTransportError extends Schema.TaggedError<ServerTransportError>()(
	'BoltServer.ServerTransportError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** Gives malformed command bodies a schema-owned client error instead of a JSON defect; stupidity:allow Q4 -- Effect TaggedError declaration is the canonical rc.109 error boundary. */
export class CommandInputError extends Schema.TaggedError<CommandInputError>()(
	'BoltServer.CommandInputError',
	{
		code: Schema.Literals(['malformed_json', 'invalid_json_value']),
		message: Schema.NonEmptyString
	}
) {}

// stupidity:allow AL10 -- public server lifecycle stays beside its constructor in the required 14-file architecture
export interface RunningServer {
	readonly address: { readonly host: string; readonly port: number };
	readonly close: () => Promise<void>;
}

// stupidity:allow AL10 -- private runtime requirement stays beside its only consumer in the required 14-file architecture
type RuntimeServices = BundleLoader | ServerHealth;
type RealtimeEvent = Extract<Invocation, { readonly _tag: 'Realtime' }>['event'];

/** Reads a bounded request body while coupling Node stream destruction to Effect interruption. */
const readBody = (
	request: IncomingMessage,
	limit: number
): Effect.Effect<Uint8Array | undefined, ServerTransportError> =>
	Effect.tryPromise({
		try: async (signal) => {
			const chunks: Array<Uint8Array> = [];
			let length = 0;
			/** Destroys the Node stream when the owning Effect is interrupted; stupidity:allow Q4 -- removable AbortSignal listener must retain callback identity. */
			const abort = () => request.destroy(signal.reason);
			signal.addEventListener('abort', abort, { once: true });
			try {
				for await (const chunk of request) {
					const bytes =
						typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
					length += bytes.byteLength;
					if (length > limit) throw new Error('request body exceeds configured limit');
					chunks.push(bytes);
				}
			} finally {
				signal.removeEventListener('abort', abort);
			}

			if (length === 0) return undefined;
			const body = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return body;
		},
		catch: (cause) =>
			new ServerTransportError({
				operation: 'BoltServer.Server.readBody',
				message: 'Unable to read request body',
				cause
			})
	});

/** Writes a terminal JSON response only while the transport remains writable. */
const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
	if (response.writableEnded || response.destroyed) return;
	const body = JSON.stringify(value);
	if (!response.headersSent) {
		response.statusCode = status;
		response.setHeader('content-type', 'application/json; charset=utf-8');
		response.setHeader('content-length', Buffer.byteLength(body));
	}
	response.end(body);
};

/** Preserves every incoming HTTP header value while normalizing names for case-insensitive lookup. */
const rawRequestHeaders = (request: IncomingMessage): Record<string, Array<string>> => {
	const headers: Record<string, Array<string>> = {};
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const rawName = request.rawHeaders[index];
		const value = request.rawHeaders[index + 1];
		if (rawName === undefined || value === undefined) continue;
		const name = rawName.toLowerCase();
		const existing = headers[name];
		if (existing === undefined) headers[name] = [value];
		else existing.push(value);
	}
	return headers;
};

/** Converts a schema-validated Bolt dispatch result into one Node response. */
const writeDispatchResult = (response: ServerResponse, result: BundleResult): void => {
	if (result._tag === 'Failure') {
		writeJson(response, result.error.httpStatus ?? 500, result.error);
		return;
	}

	response.statusCode = result.response.status;
	for (const [name, values] of Object.entries(result.response.headers)) {
		response.setHeader(name, values);
	}
	if (result.response.body !== undefined) {
		response.end(result.response.body);
	} else if (result.response.value !== undefined) {
		if (!response.hasHeader('content-type')) {
			response.setHeader('content-type', 'application/json; charset=utf-8');
		}
		response.end(JSON.stringify(result.response.value));
	} else {
		response.end();
	}
};

const dispatch = Effect.fn('BoltServer.Server.dispatch')(function* (
	invocation: Invocation,
	facilities: FacilityBindings,
	timeoutMillis: number
) {
	const loader = yield* BundleLoader;
	const health = yield* ServerHealth;
	return yield* health.admit(
		Effect.gen(function* () {
			const bundle = yield* loader.load();
			const unsafeResult = yield* Effect.tryPromise({
				try: (signal) => bundle.dispatch(invocation, facilities, signal),
				catch: (cause) =>
					new ServerTransportError({
						operation: 'BoltServer.Server.dispatch',
						message: 'Bolt bundle dispatch failed',
						cause
					})
			}).pipe(
				Effect.timeout(timeoutMillis),
				// A bare `TimeoutError` carries no message, so it reached the caller as an unexplained
				// 500. The deadline is the one fact worth reporting about it.
				Effect.catchTag('TimeoutError', () =>
					Effect.fail(
						new ServerTransportError({
							operation: 'BoltServer.Server.dispatch',
							message: `Bolt bundle dispatch exceeded its ${timeoutMillis}ms deadline`
						})
					)
				)
			);
			return yield* Schema.decodeUnknownEffect(BundleResult)(unsafeResult).pipe(
				Effect.mapError(
					(cause) =>
						new ServerTransportError({
							operation: 'BoltServer.Server.decodeResponse',
							message: 'Bolt bundle returned an invalid response',
							cause
						})
				)
			);
		})
	);
});

const dispatchRealtime = Effect.fn('BoltServer.Server.dispatchRealtime')(function* (
	connectionId: string,
	event: RealtimeEvent,
	configuration: ServerConfiguration,
	facilities: FacilityBindings
) {
	const now = yield* Clock.currentTimeMillis;
	const invocation = Invocation.cases.Realtime.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(randomUUID()),
		scope: configuration.scope,
		deadlineEpochMs: now + configuration.invocationTimeoutMillis,
		connectionId,
		event
	});
	const result = yield* dispatch(invocation, facilities, configuration.invocationTimeoutMillis);
	if (result._tag === 'Failure') {
		return yield* new ServerTransportError({
			operation: 'BoltServer.Server.realtime',
			message: result.error.message
		});
	}
	let realtime = result.response.realtime;
	const transport = facilities.transport;
	if (transport !== undefined) {
		const transportResult = yield* Effect.tryPromise({
			try: (signal) =>
				transport.call(
					{
						invocationId: invocation.id,
						effectId: EffectId.make(`${invocation.id}:transport-pull`),
						deadlineEpochMs: invocation.deadlineEpochMs,
						idempotencyKey: `${invocation.id}:transport-pull`
					},
					TransportRequest.cases.Pull.make({ connectionId, maxFrames: 256 }),
					signal
				),
			catch: (cause) =>
				new ServerTransportError({
					operation: 'BoltServer.Server.transportPull',
					message: 'Transport pull failed during realtime dispatch',
					cause
				})
		});
		if (transportResult._tag === 'Success' && transportResult.value.frames !== undefined) {
			const transportFrames = transportResult.value.frames.map((frame) => ({
				cursor: frame.cursor ?? `${connectionId}:${frame.sequence}`,
				kind: frame.kind,
				bytes: frame.bytes
			}));
			realtime =
				realtime === undefined
					? { frames: transportFrames }
					: { ...realtime, frames: [...realtime.frames, ...transportFrames] };
		}
	}
	return realtime;
});
const handleSse = Effect.fn('BoltServer.Server.handleSse')(function* (
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	configuration: ServerConfiguration,
	facilities: FacilityBindings
) {
	const requestedConnectionId = url.searchParams.get('connectionId') ?? undefined;
	const connectionId = requestedConnectionId ?? randomUUID();
	const afterCursor = url.searchParams.get('afterCursor') ?? undefined;
	const requestedMaxFrames = Number(url.searchParams.get('maxFrames') ?? '64');
	const maxFrames = Number.isInteger(requestedMaxFrames)
		? Math.min(Math.max(requestedMaxFrames, 1), 256)
		: 64;
	let event: RealtimeEvent;
	if (request.method === 'DELETE') {
		if (requestedConnectionId === undefined) {
			writeJson(response, 400, { code: 'bolt_server.connection_id_required' });
			return;
		}
		event = Invocation.cases.Realtime.fields.event.cases.Cancel.make({
			reason: 'SSE client cancelled the session'
		});
	} else if (request.method !== 'GET') {
		response.statusCode = 405;
		response.setHeader('allow', 'GET, DELETE');
		response.end();
		return;
	} else if (requestedConnectionId === undefined) {
		event = Invocation.cases.Realtime.fields.event.cases.Open.make({ protocol: 'sse' });
	} else {
		event = Invocation.cases.Realtime.fields.event.cases.Pull.make({
			...(afterCursor === undefined ? {} : { afterCursor }),
			maxFrames
		});
	}

	const output = yield* dispatchRealtime(connectionId, event, configuration, facilities);
	response.statusCode = 200;
	response.setHeader('content-type', 'text/event-stream; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.setHeader('x-bolt-connection-id', connectionId);
	yield* Effect.tryPromise({
		try: (signal) =>
			(output?.frames ?? []).reduce(
				(pending, frame) =>
					pending.then(async () => {
						if (signal.aborted || response.destroyed) throw signal.reason;
						const payload = JSON.stringify({
							cursor: frame.cursor,
							kind: frame.kind,
							bytes: Buffer.from(frame.bytes).toString('base64')
						});
						if (!response.write(`event: ${frame.kind}\ndata: ${payload}\n\n`)) {
							await Promise.race([
								once(response, 'drain', { signal }),
								once(response, 'close', { signal }).then(() => {
									throw new Error('SSE client disconnected');
								})
							]);
						}
					}),
				Promise.resolve()
			),
		catch: (cause) =>
			new ServerTransportError({
				operation: 'BoltServer.Server.writeSse',
				message: 'Unable to write Bolt SSE frames',
				cause
			})
	});
	response.end();
});

const handleHttp = Effect.fn('BoltServer.Server.handleHttp')(function* (
	request: IncomingMessage,
	response: ServerResponse,
	configuration: ServerConfiguration,
	facilities: FacilityBindings
) {
	const loader = yield* BundleLoader;
	const health = yield* ServerHealth;
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
	if (url.pathname === '/__bolt/realtime/sse') {
		return yield* handleSse(request, response, url, configuration, facilities);
	}

	if (url.pathname === '/healthz' || url.pathname === '/readyz') {
		const snapshot = yield* health.snapshot();
		const available = url.pathname === '/healthz' ? !snapshot.finalized : snapshot.ready;
		writeJson(response, available ? 200 : 503, snapshot);
		return;
	}

	// Host plugins (the Data Browser and anything else the host surfaces) reach Bolt as `Plugin`
	// invocations. Bolt's dispatcher has always handled them; nothing exposed them over HTTP, so a
	// self-hosted deployment had no way to serve a host plugin at all.
	if (url.pathname.startsWith('/_bolt/plugin/')) {
		if (request.method !== 'POST') {
			response.statusCode = 405;
			response.setHeader('allow', 'POST');
			response.end();
			return;
		}
		const segments = url.pathname.slice('/_bolt/plugin/'.length).split('/');
		const encodedPlugin = segments[0] ?? '';
		const encodedCommand = segments[1] ?? '';
		if (encodedPlugin.length === 0 || encodedCommand.length === 0) {
			writeJson(response, 400, { code: 'bolt_server.plugin_command_required' });
			return;
		}
		const names = yield* Effect.try({
			try: () => ({
				plugin: decodeURIComponent(encodedPlugin),
				command: decodeURIComponent(encodedCommand)
			}),
			catch: (cause) =>
				new ServerTransportError({
					operation: 'BoltServer.Server.decodePlugin',
					message: 'Bolt plugin path is not valid URI data',
					cause
				})
		});
		const pluginBody = yield* readBody(request, configuration.requestBodyLimitBytes);
		const decodedPayload = yield* (
			pluginBody === undefined
				? Effect.succeed<Schema.Json>(null)
				: Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
						new TextDecoder().decode(pluginBody)
					).pipe(
						Effect.mapError(
							() =>
								new CommandInputError({
									code: 'malformed_json',
									message: 'Bolt plugin body is not valid JSON'
								})
						)
					)
		).pipe(Effect.result);
		if (Result.isFailure(decodedPayload)) {
			writeJson(response, 400, decodedPayload.failure);
			return;
		}
		const payload = decodedPayload.success;
		const read = (field: string): Schema.Json =>
			payload !== null && typeof payload === 'object' && !Array.isArray(payload)
				? ((Reflect.get(payload, field) ?? null) as Schema.Json)
				: null;
		const pluginNow = yield* Clock.currentTimeMillis;
		writeDispatchResult(
			response,
			yield* dispatch(
				Invocation.cases.Plugin.make({
					protocolVersion: PROTOCOL_VERSION,
					id: InvocationId.make(randomUUID()),
					scope: configuration.scope,
					deadlineEpochMs: pluginNow + configuration.invocationTimeoutMillis,
					plugin: names.plugin,
					command: names.command,
					input: read('input'),
					// Carried from the request rather than from the body, so the credential Bolt
					// authenticates is the one the caller actually presented on the wire — the body is
					// the part an attacker writes, and `trustedContext` rides in it.
					headers: rawRequestHeaders(request),
					trustedContext: read('trustedContext')
				}),
				facilities,
				configuration.invocationTimeoutMillis
			)
		);
		return;
	}

	if (url.pathname.startsWith('/_bolt/command/')) {
		if (request.method !== 'POST') {
			response.statusCode = 405;
			response.setHeader('allow', 'POST');
			response.end();
			return;
		}
		const encodedCommand = url.pathname.slice('/_bolt/command/'.length);
		if (encodedCommand.length === 0) {
			writeJson(response, 400, { code: 'bolt_server.command_required' });
			return;
		}
		const command = yield* Effect.try({
			try: () => decodeURIComponent(encodedCommand),
			catch: (cause) =>
				new ServerTransportError({
					operation: 'BoltServer.Server.decodeCommand',
					message: 'Bolt command path is not valid URI data',
					cause
				})
		});
		const body = yield* readBody(request, configuration.requestBodyLimitBytes);
		const decodedInput = yield* (
			body === undefined
				? Effect.succeed<Schema.Json>(null)
				: Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
						new TextDecoder().decode(body)
					).pipe(
						Effect.mapError(
							() =>
								new CommandInputError({
									code: 'malformed_json',
									message: 'Bolt command body is not valid JSON'
								})
						)
					)
		).pipe(Effect.result);
		if (Result.isFailure(decodedInput)) {
			writeJson(response, 400, decodedInput.failure);
			return;
		}
		const input = decodedInput.success;
		const now = yield* Clock.currentTimeMillis;
		const invocation = Invocation.cases.Command.make({
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make(randomUUID()),
			scope: configuration.scope,
			deadlineEpochMs: now + configuration.invocationTimeoutMillis,
			command,
			input,
			headers: rawRequestHeaders(request)
		});
		writeDispatchResult(
			response,
			yield* dispatch(invocation, facilities, configuration.invocationTimeoutMillis)
		);
		return;
	}

	const bundle = yield* loader.load();
	/**
	 * Static assets answer at the path they were built under, and `/` is not one of them.
	 *
	 * This used to rewrite `/` to `/index.html`, which the client build emitted: a document that
	 * stamped `data-bolt-tenant="local"`, `data-bolt-environment="development"` and no credential
	 * onto itself, and left the client to read them back. That page is gone. An artifact's client is
	 * mounted by a host that states who is signed in and which organization is routed; a page that
	 * answers those questions by asserting them is the defect, not a convenience. `/` now falls
	 * through to the artifact's own request dispatch, which is where an authored root route lives.
	 */
	const asset = bundle.manifest.staticAssets.find(
		(candidate) => `/${candidate.path.replace(/^\/+/, '')}` === url.pathname
	);
	if (asset !== undefined && (request.method === 'GET' || request.method === 'HEAD')) {
		response.statusCode = 200;
		response.setHeader('content-type', asset.contentType);
		response.setHeader('etag', `"${asset.sha256}"`);
		response.setHeader('content-length', asset.bytes.byteLength);
		response.end(request.method === 'HEAD' ? undefined : asset.bytes);
		return;
	}

	const body = yield* readBody(request, configuration.requestBodyLimitBytes);
	const now = yield* Clock.currentTimeMillis;
	const invocation = Invocation.cases.Request.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(randomUUID()),
		scope: configuration.scope,
		deadlineEpochMs: now + configuration.invocationTimeoutMillis,
		method: request.method ?? 'GET',
		url: request.url ?? '/',
		headers: rawRequestHeaders(request),
		...(body === undefined ? {} : { body })
	});
	const result = yield* dispatch(invocation, facilities, configuration.invocationTimeoutMillis);
	writeDispatchResult(response, result);
});

/** Applies frames and an optional close instruction in Bolt cursor order. */
const applyRealtimeOutput = async (
	socket: WebSocket,
	output: RealtimeOutput | undefined
): Promise<void> => {
	if (output === undefined) return;
	await output.frames.reduce(
		(pending, frame) =>
			pending.then(
				() =>
					new Promise<void>((resolve, reject) => {
						if (socket.readyState !== WebSocket.OPEN) {
							resolve();
							return;
						}
						socket.send(frame.bytes, { binary: frame.kind === 'binary' }, (error) => {
							if (error == null) resolve();
							else reject(error);
						});
					})
			),
		Promise.resolve()
	);
	if (output.close !== undefined && socket.readyState === WebSocket.OPEN) {
		socket.close(output.close.code, output.close.reason);
	}
};

/** Starts the HTTP, static, SSE, and WebSocket shell around one loaded Bolt bundle. */
export const startServer = async <E>(
	configuration: ServerConfiguration,
	facilities: FacilityBindings,
	runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, E>
): Promise<RunningServer> => {
	const websocketServer = new WebSocketServer({ noServer: true });
	const shutdown = new AbortController();
	const cancelConnections = new Set<() => Promise<void>>();
	const server = createServer((request, response) => {
		const requestAbort = new AbortController();
		request.once('aborted', () => requestAbort.abort(new Error('HTTP client disconnected')));
		response.once('close', () => {
			if (!response.writableEnded) {
				requestAbort.abort(new Error('HTTP client disconnected'));
			}
		});

		void runtime
			.runPromise(handleHttp(request, response, configuration, facilities), {
				signal: AbortSignal.any([shutdown.signal, requestAbort.signal])
			})
			.catch((cause: unknown) => {
				// The response body stays opaque, but an unexplained 500 with no server-side record
				// is undiagnosable — every operator report of one started here.
				console.error(`bolt-server: ${request.method} ${request.url} failed`, cause);
				writeJson(response, 500, { code: 'bolt_server.internal_error' });
			});
	});

	websocketServer.on('connection', (socket, request) => {
		const connectionId = randomUUID();
		let sequence = 0;
		let tail = Promise.resolve();

		/** Dispatches one bounded realtime event under the server shutdown signal; stupidity:allow Q4 -- per-connection closure binds session identity and shutdown signal. */
		const invoke = (event: RealtimeEvent) =>
			runtime.runPromise(dispatchRealtime(connectionId, event, configuration, facilities), {
				signal: shutdown.signal
			});

		/** Serializes events and cursor pulls for one socket to preserve session order. */
		const enqueue = (event: RealtimeEvent): Promise<void> => {
			tail = tail
				.then(async () => {
					/** Recursively drains Pull pages because each cursor depends on its predecessor. */
					const pullRemaining = async (cursor: string | undefined): Promise<void> => {
						if (cursor === undefined || socket.readyState !== WebSocket.OPEN) return;
						const pulled = await invoke(
							Invocation.cases.Realtime.fields.event.cases.Pull.make({
								afterCursor: cursor,
								maxFrames: 64
							})
						);
						await applyRealtimeOutput(socket, pulled);
						if ((pulled?.frames.length ?? 0) === 0) return;
						await pullRemaining(pulled?.nextCursor);
					};
					const output = await invoke(event);
					await applyRealtimeOutput(socket, output);
					await pullRemaining(output?.nextCursor);
				})
				.catch(() => {
					if (socket.readyState === WebSocket.OPEN)
						socket.close(1011, 'Bolt realtime dispatch failed');
				});
			return tail;
		};
		/** Gives Bolt a durable cancellation event before the host closes the socket; stupidity:allow Q4 -- Set membership requires one stable per-connection callback identity. */
		const cancel = () =>
			enqueue(
				Invocation.cases.Realtime.fields.event.cases.Cancel.make({
					reason: 'Server shutting down'
				})
			);
		cancelConnections.add(cancel);

		const protocol = request.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
		enqueue(
			Invocation.cases.Realtime.fields.event.cases.Open.make(
				protocol === undefined || protocol.length === 0 ? {} : { protocol }
			)
		);
		socket.on('message', (data, isBinary) => {
			enqueue(
				Invocation.cases.Realtime.fields.event.cases.Input.make({
					frame: {
						sequence: sequence++,
						kind: isBinary ? 'binary' : 'text',
						bytes: Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data)
					}
				})
			);
		});
		socket.once('close', (code, reason) => {
			cancelConnections.delete(cancel);
			enqueue(
				Invocation.cases.Realtime.fields.event.cases.Close.make({
					code,
					reason: reason.toString('utf8')
				})
			);
		});
	});

	server.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (url.pathname !== '/__bolt/realtime') {
			socket.destroy();
			return;
		}
		websocketServer.handleUpgrade(request, socket, head, (websocket) => {
			websocketServer.emit('connection', websocket, request);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(configuration.port, configuration.host, () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Bolt server listener did not expose a TCP address');
	}

	let closePromise: Promise<void> | undefined;
	/** Stops listener admission, cancels sessions, and closes every transport exactly once. */
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			const listenerClosed = new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
			});
			await Promise.allSettled([...cancelConnections].map((cancel) => cancel()));
			shutdown.abort(new Error('Bolt server is shutting down'));
			for (const client of websocketServer.clients) client.close(1001, 'Server shutting down');
			websocketServer.close();
			await listenerClosed;
		})();
		return closePromise;
	};

	return {
		address: { host: configuration.host, port: address.port },
		close
	};
};

/** Names the physical transport constructor for explicit host composition. */
export const ServerTransport = { start: startServer };
