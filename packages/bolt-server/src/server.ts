import {
	BundleResult,
	EffectId,
	Invocation,
	InvocationId,
	PluginTrustedContext,
	PROTOCOL_VERSION,
	TransportRequest,
	type FacilityBindings,
	type RealtimeOutput
} from '@norbital-ai/bolt-protocol';
import {
	Clock,
	Context,
	Cause,
	Effect,
	Layer,
	ManagedRuntime,
	Number as EffectNumber,
	Option,
	Result,
	Schema,
	Semaphore
} from 'effect';
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

/** The server lifecycle: the transport it owns and the one-shot gate that closes it. */
export interface RunningServer {
	readonly address: { readonly host: string; readonly port: number };
	readonly close: () => Promise<void>;
}

/** The runtime's services: one loader, one health machine, one id-ministing service. */
type RuntimeServices = BundleLoader | ServerHealth | UuidGeneration;
type RealtimeEvent = Extract<Invocation, { readonly _tag: 'Realtime' }>['event'];

/**
 * How this host mints the random identifiers every invocation and connection needs.
 *
 * A service rather than a direct `randomUUID()` call so the effects that mint identifiers are
 * deterministic under an injected provider, and so the caller of a mint can be held responsible for
 * the source's security posture (the default is `node:crypto`, not a numeric RNG).
 */
export class UuidGeneration extends Context.Service<
	UuidGeneration,
	{ readonly next: () => InvocationId }
>()('@norbital-ai/bolt-server/UuidGeneration') {}

export const uuidGenerationLayer = Layer.succeed(UuidGeneration, {
	next: () => InvocationId.make(randomUUID())
});

/** The payload shape a host plugin may send, decoded once instead of field-guessed. */
const PluginInput = Schema.Struct({
	input: Schema.optionalKey(Schema.Json),
	trustedContext: Schema.optionalKey(PluginTrustedContext)
});

/** Reads a bounded request body while coupling Node stream destruction to Effect interruption. */
const readBody = (
	request: IncomingMessage,
	limit: number
): Effect.Effect<Uint8Array | undefined, ServerTransportError> =>
	Effect.callback((resume, signal) => {
		const chunks: Array<Uint8Array> = [];
		let length = 0;
		let settled = false;
		const cleanup = () => {
			request.off('data', onData);
			request.off('end', onEnd);
			request.off('error', onError);
			request.off('aborted', onAborted);
			signal.removeEventListener('abort', onAbort);
		};
		const failure = (cause: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			resume(
				Effect.fail(
					new ServerTransportError({
						operation: 'BoltServer.Server.readBody',
						message: 'Unable to read request body',
						cause
					})
				)
			);
		};
		function onData(chunk: string | Buffer): void {
			const bytes =
				typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
			length += bytes.byteLength;
			if (length > limit) {
				failure(new Error('request body exceeds configured limit'));
				request.destroy();
				return;
			}
			chunks.push(bytes);
		}
		function onEnd(): void {
			if (settled) return;
			settled = true;
			cleanup();
			if (length === 0) {
				resume(Effect.succeed(undefined));
				return;
			}
			const body = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			resume(Effect.succeed(body));
		}
		function onError(cause: Error): void {
			failure(cause);
		}
		function onAborted(): void {
			failure(new Error('request body stream was aborted'));
		}
		function onAbort(): void {
			if (settled) return;
			settled = true;
			cleanup();
			request.destroy(signal.reason);
		}

		request.on('data', onData);
		request.once('end', onEnd);
		request.once('error', onError);
		request.once('aborted', onAborted);
		signal.addEventListener('abort', onAbort, { once: true });
		return Effect.sync(cleanup);
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
	const uuid = yield* UuidGeneration;
	const invocation = Invocation.cases.Realtime.make({
		protocolVersion: PROTOCOL_VERSION,
		id: uuid.next(),
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
	const uuid = yield* UuidGeneration;
	const connectionId = requestedConnectionId ?? uuid.next();
	const afterCursor = url.searchParams.get('afterCursor') ?? undefined;
	const requestedMaxFrames = Number(url.searchParams.get('maxFrames') ?? '64');
	const maxFrames = Number.isInteger(requestedMaxFrames)
		? EffectNumber.clamp({ minimum: 1, maximum: 256 })(requestedMaxFrames)
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
	yield* Effect.forEach(
		output?.frames ?? [],
		(frame) =>
			Effect.tryPromise({
				try: async (signal) => {
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
				},
				catch: (cause) =>
					new ServerTransportError({
						operation: 'BoltServer.Server.writeSse',
						message: 'Unable to write Bolt SSE frames',
						cause
					})
			}),
		{ discard: true }
	);
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
		const parsedPayload = yield* (
			pluginBody === undefined
				? Effect.succeed<Schema.Json>({})
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
		if (Result.isFailure(parsedPayload)) {
			writeJson(response, 400, parsedPayload.failure);
			return;
		}
		const decodedPayload = yield* Schema.decodeUnknownEffect(PluginInput)(
			parsedPayload.success
		).pipe(
			Effect.mapError(
				() =>
					new CommandInputError({
						code: 'invalid_json_value',
						message: 'Bolt plugin body does not match the plugin input contract'
					})
			),
			Effect.result
		);
		if (Result.isFailure(decodedPayload)) {
			writeJson(response, 400, decodedPayload.failure);
			return;
		}
		const pluginNow = yield* Clock.currentTimeMillis;
		writeDispatchResult(
			response,
			yield* dispatch(
				Invocation.cases.Plugin.make({
					protocolVersion: PROTOCOL_VERSION,
					id: (yield* UuidGeneration).next(),
					scope: configuration.scope,
					deadlineEpochMs: pluginNow + configuration.invocationTimeoutMillis,
					plugin: names.plugin,
					command: names.command,
					input: decodedPayload.success.input ?? null,
					// Carried from the request rather than from the body, so the credential Bolt
					// authenticates is the one the caller actually presented on the wire — the body is
					// the part an attacker writes, and `trustedContext` rides in it.
					headers: rawRequestHeaders(request),
					trustedContext: decodedPayload.success.trustedContext ?? {}
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
			id: (yield* UuidGeneration).next(),
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
		id: (yield* UuidGeneration).next(),
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

/** Completes one realtime frame write through ws's callback API, mapped to the transport error contract. */
const writeRealtimeFrame = (
	socket: WebSocket,
	frame: RealtimeOutput['frames'][number]
): Effect.Effect<void, ServerTransportError> =>
	Effect.callback<void, unknown>((resume) => {
		if (socket.readyState !== WebSocket.OPEN) {
			resume(Effect.void);
			return;
		}
		socket.send(frame.bytes, { binary: frame.kind === 'binary' }, (error) => {
			if (error == null) resume(Effect.void);
			else resume(Effect.fail(error));
		});
	}).pipe(
		Effect.mapError(
			(cause) =>
				new ServerTransportError({
					operation: 'BoltServer.Server.writeRealtimeFrame',
					message: 'Unable to write Bolt realtime frame',
					cause
				})
		)
	);

/** Applies frames and an optional close instruction in Bolt cursor order. */
const applyRealtimeOutput = Effect.fn('BoltServer.Server.applyRealtimeOutput')(function* (
	socket: WebSocket,
	output: RealtimeOutput | undefined
) {
	if (output === undefined) return;
	yield* Effect.forEach(output.frames, (frame) => writeRealtimeFrame(socket, frame));
	if (output.close !== undefined && socket.readyState === WebSocket.OPEN) {
		socket.close(output.close.code, output.close.reason);
	}
});

/** One event, dispatched and drained under a single serial permit; the repeated Pulls depend on each other. */
const processRealtimeEvent = Effect.fn('BoltServer.Server.processRealtimeEvent')(function* (
	connectionId: string,
	event: RealtimeEvent,
	configuration: ServerConfiguration,
	facilities: FacilityBindings,
	socket: WebSocket
) {
	const output = yield* dispatchRealtime(connectionId, event, configuration, facilities);
	yield* applyRealtimeOutput(socket, output);
	let cursor = output?.nextCursor;
	while (cursor !== undefined && socket.readyState === WebSocket.OPEN) {
		const pulled = yield* dispatchRealtime(
			connectionId,
			Invocation.cases.Realtime.fields.event.cases.Pull.make({
				afterCursor: cursor,
				maxFrames: 64
			}),
			configuration,
			facilities
		);
		yield* applyRealtimeOutput(socket, pulled);
		if ((pulled?.frames.length ?? 0) === 0) return;
		cursor = pulled?.nextCursor;
	}
});

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
				void Effect.runPromise(
					Effect.logError(`bolt-server: ${request.method} ${request.url} failed`, cause)
				);
				writeJson(response, 500, { code: 'bolt_server.internal_error' });
			});
	});

	websocketServer.on('connection', (socket, request) => {
		/** Mints the session identity and the serialization gate before any event can be enqueued. */
		const session = () =>
			Effect.gen(function* () {
				const uuid = yield* UuidGeneration;
				const semaphore = yield* Semaphore.make(1);
				return { connectionId: uuid.next(), semaphore };
			});
		void runtime
			.runPromise(session(), { signal: shutdown.signal })
			.then(({ connectionId, semaphore }) => {
				let sequence = 0;

				/** Runs one event under the session permit, reporting a dispatch failure by closing the socket. */
				const enqueue = (event: RealtimeEvent): Promise<void> =>
					runtime.runPromise(
						Semaphore.withPermit(semaphore)(
							processRealtimeEvent(connectionId, event, configuration, facilities, socket)
						).pipe(
							Effect.catchCause((cause) =>
								Effect.sync(() => {
									if (!Cause.hasInterruptsOnly(cause) && socket.readyState === WebSocket.OPEN) {
										socket.close(1011, 'Bolt realtime dispatch failed');
									}
								})
							)
						),
						{ signal: shutdown.signal }
					);
				/** Gives Bolt a durable cancellation event before the host closes the socket; stupidity:allow Q4 -- Set membership requires one stable per-connection callback identity. */
				const cancel = (): Promise<void> =>
					enqueue(
						Invocation.cases.Realtime.fields.event.cases.Cancel.make({
							reason: 'Server shutting down'
						})
					);
				cancelConnections.add(cancel);

				const protocol = request.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
				void enqueue(
					Invocation.cases.Realtime.fields.event.cases.Open.make(
						protocol === undefined || protocol.length === 0 ? {} : { protocol }
					)
				);
				socket.on('message', (data, isBinary) => {
					void enqueue(
						Invocation.cases.Realtime.fields.event.cases.Input.make({
							frame: {
								sequence: sequence++,
								kind: isBinary ? 'binary' : 'text',
								bytes: Array.isArray(data)
									? new Uint8Array(Buffer.concat(data))
									: new Uint8Array(data)
							}
						})
					);
				});
				socket.once('close', (code, reason) => {
					if (shutdown.signal.aborted) {
						cancelConnections.delete(cancel);
						return;
					}
					void Effect.runPromise(
						Effect.tryPromise(() =>
							enqueue(
								Invocation.cases.Realtime.fields.event.cases.Close.make({
									code,
									reason: reason.toString('utf8')
								})
							)
						).pipe(
							Effect.ensuring(Effect.sync(() => cancelConnections.delete(cancel))),
							Effect.catch(() => Effect.void)
						)
					);
				});
			})
			.catch((cause: unknown) => {
				void Effect.runPromise(
					Effect.logError('bolt-server: websocket session setup failed', cause)
				);
				if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
					socket.close(1011, 'Bolt websocket session failed');
				}
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
