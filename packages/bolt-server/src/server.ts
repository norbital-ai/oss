import {
	ARTIFACT_ASSET_DIRECTORY,
	BundleResult,
	CollectionMutationIdempotencyKey,
	DispatchResponse,
	EffectId,
	Invocation,
	InvocationId,
	PluginTrustedContext,
	PROTOCOL_VERSION,
	SYNC_CONNECTION_HEADER,
	SyncAdvanceResponse,
	SyncConnectEvaluation,
	SyncConnectRequest,
	TransportRequest,
	type FacilityBindings,
	type RealtimeOutput,
	type SyncApplyFrame,
	type SyncReadyFrame
} from '@norbital-ai/bolt-protocol';
import {
	Clock,
	Context,
	Cause,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Option,
	Result,
	Schema,
	Semaphore
} from 'effect';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { BundleLoadError, BundleLoader } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { AdmissionStopped, ServerHealth } from './health.js';
import type { TaskInvocationControl } from './schedules.js';
import { systemCommandHeaders } from './system-headers.js';
import {
	makeSyncHost,
	SyncConnectionUnavailable,
	SyncGuestRejected,
	type SyncGuestBridge,
	type SyncInterface,
	type SyncSink
} from './sync-host.js';

/** Identifies a bounded Node transport operation that could not complete safely. */
export class ServerTransportError extends Schema.TaggedError<ServerTransportError>()(
	'BoltServer.ServerTransportError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** Gives malformed command bodies a schema-owned client error instead of a JSON defect. */
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
	// repository-health:allow EFF2 -- Public host finalizers preserve the established Promise lifecycle contract.
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

/** Builds the UUID service from an injected source so tests can own a deterministic sequence. */
const makeUuidGenerationLayer = (nextUuid: () => string) =>
	Layer.succeed(UuidGeneration, {
		next: () => InvocationId.make(nextUuid())
	});

export const uuidGenerationLayer = makeUuidGenerationLayer(randomUUID);

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
			request.off('error', failure);
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
		request.once('error', failure);
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

/**
 * Where an artifact's blobs sit: beside the bundle module the host was pointed at.
 *
 * Derived rather than configured, because the compiler writes both and a second setting is a second
 * thing that can disagree with the first. The blob's name is its digest, which the loader has
 * already re-verified against the index at startup.
 */
const assetDirectoryOf = (bundlePath: string): string =>
	join(dirname(resolve(bundlePath)), ARTIFACT_ASSET_DIRECTORY);

/**
 * Sends one blob without holding it in memory.
 *
 * A workspace that ships PGlite serves a 13 MB WebAssembly module; buffering it per request is the
 * memory profile this whole change exists to remove, one layer up. `pipeline` also closes the read
 * stream when the client disconnects mid-transfer, which a manual `pipe` does not.
 */
const streamAssetBlob = (
	response: ServerResponse,
	blobPath: string
): Effect.Effect<void, ServerTransportError> =>
	Effect.tryPromise({
		try: () => pipeline(createReadStream(blobPath), response),
		catch: (cause) =>
			new ServerTransportError({
				operation: 'BoltServer.Server.streamAsset',
				message: `Unable to stream Bolt asset blob ${blobPath}`,
				cause
			})
	});

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

/** The live-query wire, per §1.4: one ready event, then exclusively apply events. */
const SYNC_KEEPALIVE_MILLIS = 25_000;
const sseEncoder = new TextEncoder();
const sseReadyBytes = (ready: SyncReadyFrame): Uint8Array =>
	sseEncoder.encode(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
const sseApplyBytes = (frame: SyncApplyFrame): Uint8Array =>
	sseEncoder.encode(`event: apply\ndata: ${JSON.stringify(frame)}\n\n`);

/**
 * The opaque credential a connection carries.
 *
 * The host never derives a subject from it — the guest authenticates it afresh on every handshake
 * and every advance, which is what makes revocation and policy drift visible on a wake.
 */
const bearerCredential = (headers: Record<string, Array<string>>): string => {
	const value = headers['authorization']?.[0];
	if (value === undefined) return '';
	const bare = value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value;
	return bare.trim();
};

/**
 * The writer-owned ledger ids one committed invocation settles.
 *
 * The change list carries its mutation ids; `collections.mutate` also names its idempotency key on
 * the request and echoes it in the response, and terminal outcomes that committed no collection
 * change ride that pair.
 */
const mutationIdsFrom = (
	command: string,
	input: Schema.Json,
	response: DispatchResponse
): ReadonlyArray<CollectionMutationIdempotencyKey> => {
	const pending = new Set<CollectionMutationIdempotencyKey>();
	for (const change of response.changes ?? []) {
		if (change.mutationId !== undefined) pending.add(change.mutationId);
	}
	if (command !== 'collections.mutate') return [...pending];
	const inputId =
		typeof input === 'object' && input !== null && !Array.isArray(input)
			? Reflect.get(input, 'idempotencyKey')
			: undefined;
	const responseId =
		typeof response.value === 'object' && response.value !== null && !Array.isArray(response.value)
			? Reflect.get(response.value, 'mutationId')
			: undefined;
	for (const candidate of [inputId, responseId]) {
		const decoded = Schema.decodeUnknownOption(CollectionMutationIdempotencyKey)(candidate);
		if (Option.isSome(decoded)) pending.add(decoded.value);
	}
	return [...pending];
};

const dispatch = Effect.fn('BoltServer.Server.dispatch')(function* (
	invocation: Invocation,
	facilities: FacilityBindings,
	timeoutMillis: number,
	taskInvocations?: TaskInvocationControl
) {
	const loader = yield* BundleLoader;
	const health = yield* ServerHealth;
	return yield* health.admit(
		Effect.gen(function* () {
			const bundle = yield* loader.load();
			const unsafeResult = yield* Effect.tryPromise({
				try: (signal) => {
					const controller = taskInvocations?.open(invocation.id);
					return bundle
						.dispatch(
							invocation,
							facilities,
							controller === undefined ? signal : AbortSignal.any([signal, controller.signal])
						)
						.finally(() => {
							if (controller !== undefined) taskInvocations?.close(invocation.id, controller);
						});
				},
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

const handleHttp = Effect.fn('BoltServer.Server.handleHttp')(function* (
	request: IncomingMessage,
	response: ServerResponse,
	configuration: ServerConfiguration,
	facilities: FacilityBindings,
	sync: SyncInterface,
	taskInvocations?: TaskInvocationControl
) {
	const loader = yield* BundleLoader;
	const health = yield* ServerHealth;
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
	if (url.pathname === '/healthz' || url.pathname === '/readyz') {
		const snapshot = yield* health.snapshot();
		const available = url.pathname === '/healthz' ? !snapshot.finalized : snapshot.ready;
		writeJson(response, available ? 200 : 503, snapshot);
		return;
	}

	// The live-query wire (§1.4). The standing stream is opened first — its first event hands the
	// client the connection id — and the one handshake request joins every later control call to
	// that connection by header. After the handshake answers, everything is push.
	if (url.pathname === '/sync/stream') {
		if (request.method !== 'GET') {
			response.statusCode = 405;
			response.setHeader('allow', 'GET');
			response.end();
			return;
		}
		const credential = bearerCredential(rawRequestHeaders(request));
		if (credential.length === 0) {
			writeJson(response, 401, { code: 'bolt_server.sync_credential_required' });
			return;
		}
		const connectionId = (yield* UuidGeneration).next();
		let live = true;
		let keepalive: ReturnType<typeof setInterval> | undefined;
		const sink: SyncSink = {
			writable: () =>
				live && !response.destroyed && !response.writableEnded && !response.writableNeedDrain,
			write: (frame) => {
				if (!sink.writable()) return false;
				response.write(sseApplyBytes(frame));
				return true;
			},
			close: () => {
				if (!live) return;
				live = false;
				clearInterval(keepalive);
				response.end();
			}
		};
		sync.open({ connectionId, credential, sink });
		response.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		keepalive = setInterval(() => {
			// A stream the kernel has not drained for a full interval is a dead consumer: detach it
			// so the registry stops holding state for a tab nobody is reading.
			if (!sink.writable()) {
				sync.detach(connectionId);
				return;
			}
			response.write(sseEncoder.encode(': keepalive\n\n'));
		}, SYNC_KEEPALIVE_MILLIS);
		keepalive.unref();
		if (!response.write(sseReadyBytes({ connectionId }))) sync.ready(connectionId);
		response.on('drain', () => sync.ready(connectionId));
		response.once('close', () => sync.detach(connectionId));
		return;
	}

	if (url.pathname === '/sync/connect') {
		if (request.method !== 'POST') {
			response.statusCode = 405;
			response.setHeader('allow', 'POST');
			response.end();
			return;
		}
		const connectionId = rawRequestHeaders(request)[SYNC_CONNECTION_HEADER]?.[0]?.trim() ?? '';
		if (connectionId.length === 0) {
			writeJson(response, 400, { code: 'bolt_server.sync_connection_required' });
			return;
		}
		const credential = bearerCredential(rawRequestHeaders(request));
		if (credential.length === 0) {
			writeJson(response, 401, { code: 'bolt_server.sync_credential_required' });
			return;
		}
		const body = yield* readBody(request, configuration.requestBodyLimitBytes);
		const decodedRequest = body === undefined
			? yield* Effect.fail(
					new CommandInputError({
						code: 'malformed_json',
						message: 'Bolt sync connect requires a body'
					})
				)
			: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SyncConnectRequest))(
					new TextDecoder().decode(body)
				).pipe(
					Effect.mapError(
						() =>
							new CommandInputError({
								code: 'malformed_json',
								message: 'Bolt sync connect body is not a valid sync connect request'
							})
					)
				);
		const connected = yield* Effect.tryPromise({
			try: () => sync.connect({ connectionId, credential, request: decodedRequest }),
			catch: (cause) => cause
		}).pipe(Effect.result);
		if (Result.isFailure(connected)) {
			const failure = connected.failure;
			if (failure instanceof SyncGuestRejected) {
				writeJson(response, failure.status, {
					code: 'bolt_server.sync_guest_rejected',
					command: failure.command,
					message: failure.message
				});
			} else if (failure instanceof SyncConnectionUnavailable) {
				// The releaseId fence. This host pins exactly one release — `configuration.scope` —
				// and a standing connection lives only inside the process that pinned it, so a
				// connection the registry cannot re-handshake is one minted by a release this
				// process no longer serves. That is Colony's `SyncConnectionUnavailable` → 410
				// (the route there words it identically): the client driver classifies 410 as
				// terminal and the Machine answers needsReload, so a tab served by an older
				// release reloads instead of silently re-handshaking across a release boundary.
				// 404 would read as retryable and strand the tab on stale code forever.
				writeJson(response, 410, {
					code: 'bolt_server.sync_connection_unavailable',
					message: 'sync connection or its pinned release is no longer available'
				});
			} else {
				writeJson(response, 500, { code: 'bolt_server.internal_error' });
			}
			return;
		}
		writeJson(response, 200, connected.success);
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
				configuration.invocationTimeoutMillis,
				taskInvocations
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
		const result = yield* dispatch(
			invocation,
			facilities,
			configuration.invocationTimeoutMillis,
			taskInvocations
		);
		if (result._tag === 'Success') {
			// The data plane (§1.1): whatever this write committed rides the standing streams — the
			// change list is the invocation's return value, not an API, and the pump turns it into
			// one frame per attached connection with the writer's outcome riding along.
			const pending = mutationIdsFrom(command, input, result.response);
			if ((result.response.changes?.length ?? 0) > 0 || pending.length > 0) {
				const headers = rawRequestHeaders(request);
				yield* Effect.tryPromise({
					try: () =>
						sync.committed({
							writerConnectionId: headers[SYNC_CONNECTION_HEADER]?.[0]?.trim() || undefined,
							writerCredential: bearerCredential(headers),
							changes: result.response.changes ?? [],
							pending
						}),
					catch: (cause) => cause
				}).pipe(
					Effect.catch((cause) =>
						Effect.logError(`bolt-server: sync delivery after ${command} failed`, cause)
					)
				);
			}
		}
		writeDispatchResult(response, result);
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
	/**
	 * Only `browserAssets` is searched, and there is no route that reaches the other half.
	 *
	 * `serverAssets` are files the workspace declared for its own runtime — the WebAssembly module an
	 * authored hook instantiates — and they reach the guest through the asset bridge, by exact
	 * declared key. They were previously indistinguishable from the client's own output, because the
	 * plugin copied them into the same directory and the compiler indexed that directory wholesale, so
	 * declaring a server-side dependency published it. Two lists rather than one list with a flag is
	 * what makes the omission here structural: there is no field to forget to test.
	 */
	const asset = bundle.manifest.browserAssets.find(
		(candidate) => `/${candidate.path.replace(/^\/+/, '')}` === url.pathname
	);
	if (asset !== undefined && (request.method === 'GET' || request.method === 'HEAD')) {
		response.statusCode = 200;
		response.setHeader('content-type', asset.contentType);
		// The digest is both the ETag and the blob's filename, so a validator can never disagree with
		// the bytes it was computed from.
		response.setHeader('etag', `"${asset.sha256}"`);
		response.setHeader('content-length', asset.byteLength);
		if (request.method === 'HEAD') {
			response.end();
			return;
		}
		yield* streamAssetBlob(
			response,
			join(assetDirectoryOf(configuration.bundlePath), asset.sha256)
		);
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
	const result = yield* dispatch(
		invocation,
		facilities,
		configuration.invocationTimeoutMillis,
		taskInvocations
	);
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

const startServerEffect = <E>(
	configuration: ServerConfiguration,
	facilities: FacilityBindings,
	runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, E>,
	taskInvocations?: TaskInvocationControl
): Effect.Effect<RunningServer, ServerTransportError> =>
	Effect.gen(function* () {
		const websocketServer = new WebSocketServer({ noServer: true });
		const shutdown = new AbortController();
		const cancelConnections = new Set<Effect.Effect<void, unknown, RuntimeServices>>();

		/**
		 * The guest half of the wire: the two sync commands, dispatched through the one invocation
		 * path and decoded once. `sync.connect` presents the connection's credential as the caller's
		 * own authorization — the guest authenticates it afresh; nothing is carried over.
		 * `sync.advance` is system-only: the host signs it the same way it signs `host.schedules.*`.
		 */
		const dispatchSyncCommand = (
			command: 'sync.connect' | 'sync.advance',
			input: Schema.Json,
			headers: Record<string, Array<string>>
		): Effect.Effect<unknown, SyncGuestRejected | BundleLoadError | AdmissionStopped | ServerTransportError, RuntimeServices> =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const invocation = Invocation.cases.Command.make({
					protocolVersion: PROTOCOL_VERSION,
					id: (yield* UuidGeneration).next(),
					scope: configuration.scope,
					deadlineEpochMs: now + configuration.invocationTimeoutMillis,
					command,
					input,
					headers
				});
				const result = yield* dispatch(
					invocation,
					facilities,
					configuration.invocationTimeoutMillis
				);
				if (result._tag === 'Failure') {
					return yield* Effect.fail(
						new SyncGuestRejected(result.error.httpStatus ?? 500, command)
					);
				}
				return result.response.value ?? null;
			});
		const syncBridge: SyncGuestBridge = {
			connect: async ({ credential, request }) => {
				const unsafe = await runtime.runPromise(
					dispatchSyncCommand('sync.connect', request, {
						authorization: [`Bearer ${credential}`]
					})
				);
				return await Effect.runPromise(
					Schema.decodeUnknownEffect(SyncConnectEvaluation)(unsafe).pipe(
						Effect.mapError(() => new SyncGuestRejected(502, 'sync.connect'))
					)
				);
			},
			advance: async ({ request }) => {
				const headers = await runtime.runPromise(
					systemCommandHeaders(
						configuration.gatewaySecret,
						'sync.advance',
						configuration.scope.tenantId,
						request
					).pipe(
						Effect.mapError(() => new SyncGuestRejected(503, 'sync.advance'))
					)
				);
				const unsafe = await runtime.runPromise(dispatchSyncCommand('sync.advance', request, headers));
				return await Effect.runPromise(
					Schema.decodeUnknownEffect(SyncAdvanceResponse)(unsafe).pipe(
						Effect.mapError(() => new SyncGuestRejected(502, 'sync.advance'))
					)
				);
			}
		};
		const sync = makeSyncHost(syncBridge);

		const server = createServer((request, response) => {
			const requestAbort = new AbortController();
			request.once('aborted', () => requestAbort.abort(new Error('HTTP client disconnected')));
			response.once('close', () => {
				if (!response.writableEnded) {
					requestAbort.abort(new Error('HTTP client disconnected'));
				}
			});

			runtime.runFork(
				handleHttp(request, response, configuration, facilities, sync, taskInvocations).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							// The response body stays opaque, but an unexplained 500 with no
							// server-side record is undiagnosable.
							yield* Effect.logError(`bolt-server: ${request.method} ${request.url} failed`, cause);
							yield* Effect.sync(() =>
								writeJson(response, 500, { code: 'bolt_server.internal_error' })
							);
						})
					)
				),
				{ signal: AbortSignal.any([shutdown.signal, requestAbort.signal]) }
			);
		});

		websocketServer.on('connection', (socket, request) => {
			runtime.runFork(
				Effect.gen(function* () {
					const uuid = yield* UuidGeneration;
					const semaphore = yield* Semaphore.make(1);
					const connectionId = uuid.next();
					let sequence = 0;
					const enqueue = (event: RealtimeEvent) =>
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
						);
					const cancel = enqueue(
						Invocation.cases.Realtime.fields.event.cases.Cancel.make({
							reason: 'Server shutting down'
						})
					);
					cancelConnections.add(cancel);

					runtime.runFork(enqueue(Invocation.cases.Realtime.fields.event.cases.Open.make({})), {
						signal: shutdown.signal
					});
					socket.on('message', (data, isBinary) => {
						runtime.runFork(
							enqueue(
								Invocation.cases.Realtime.fields.event.cases.Input.make({
									frame: {
										sequence: sequence++,
										kind: isBinary ? 'binary' : 'text',
										bytes: Array.isArray(data)
											? new Uint8Array(Buffer.concat(data))
											: new Uint8Array(data)
									}
								})
							),
							{ signal: shutdown.signal }
						);
					});
					socket.once('close', (code, reason) => {
						if (shutdown.signal.aborted) {
							cancelConnections.delete(cancel);
							return;
						}
						runtime.runFork(
							enqueue(
								Invocation.cases.Realtime.fields.event.cases.Close.make({
									code,
									reason: reason.toString('utf8')
								})
							).pipe(Effect.ensuring(Effect.sync(() => cancelConnections.delete(cancel)))),
							{ signal: shutdown.signal }
						);
					});
				}).pipe(
					Effect.catch((cause) =>
						Effect.gen(function* () {
							yield* Effect.logError('bolt-server: websocket session setup failed', cause);
							yield* Effect.sync(() => {
								if (
									socket.readyState !== WebSocket.CLOSED &&
									socket.readyState !== WebSocket.CLOSING
								) {
									socket.close(1011, 'Bolt websocket session failed');
								}
							});
						})
					)
				),
				{ signal: shutdown.signal }
			);
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

		yield* Effect.callback<void, ServerTransportError>((resume) => {
			const onError = (cause: Error) =>
				resume(
					Effect.fail(
						new ServerTransportError({
							operation: 'BoltServer.Server.listen',
							message: 'Bolt server listener failed to start',
							cause
						})
					)
				);
			server.once('error', onError);
			server.listen(configuration.port, configuration.host, () => {
				server.off('error', onError);
				resume(Effect.void);
			});
			return Effect.sync(() => server.off('error', onError));
		});

		const address = server.address();
		if (address === null || typeof address === 'string') {
			return yield* new ServerTransportError({
				operation: 'BoltServer.Server.address',
				message: 'Bolt server listener did not expose a TCP address'
			});
		}

		const closeEffect = Effect.gen(function* () {
			const listener = yield* Effect.forkChild(
				Effect.callback<void, ServerTransportError>((resume) => {
					server.close((cause) =>
						resume(
							cause === undefined
								? Effect.void
								: Effect.fail(
										new ServerTransportError({
											operation: 'BoltServer.Server.close',
											message: 'Bolt server listener failed to close',
											cause
										})
									)
						)
					);
				})
			);
			yield* Effect.forEach(
				cancelConnections,
				(cancel) => Effect.tryPromise(() => runtime.runPromise(cancel)).pipe(Effect.result),
				{ concurrency: 'unbounded', discard: true }
			);
			shutdown.abort(new Error('Bolt server is shutting down'));
			for (const client of websocketServer.clients) {
				client.close(1001, 'Server shutting down');
			}
			websocketServer.close();
			// A restart is a registry loss by design (§2.6): the standing streams drop, every client
			// re-handshakes, and nothing replays.
			server.closeAllConnections();
			yield* Fiber.join(listener);
		});
		const closeOnce = yield* Effect.cached(closeEffect);
		const close = () => Effect.runPromise(closeOnce);

		return {
			address: { host: configuration.host, port: address.port },
			close
		};
	});

/** Starts the HTTP, static, and WebSocket shell around one loaded Bolt bundle. */
export const startServer = <E>(
	configuration: ServerConfiguration,
	facilities: FacilityBindings,
	runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, E>,
	taskInvocations?: TaskInvocationControl
) => Effect.runPromise(startServerEffect(configuration, facilities, runtime, taskInvocations));
