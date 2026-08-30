import { assert, describe, it } from '@effect/vitest';
import {
	CollectionMutationIdempotencyKey,
	EnvironmentName,
	InvocationScope,
	ReleaseId,
	systemSignaturePayload,
	SyncApplyFrame,
	SyncConnectResponse,
	SyncReadyFrame,
	TenantId,
	type SyncAdvanceRequest,
	type SyncConnectRequest,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { Effect, Redacted, Schema } from 'effect';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApplicationStartError, startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import {
	makeSyncHost,
	makeSyncRegistry,
	type SyncConnection,
	type SyncDisconnectReason,
	type SyncGuestBridge,
	type SyncInterface,
	type SyncSink
} from '../src/sync-host.js';

const GATEWAY_SECRET = 'sync-host-test-secret';

const configuration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url)),
	scope: InvocationScope.make({
		tenantId: TenantId.make('server-test'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('server-test')
	}),
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 5_000,
	requestBodyLimitBytes: 1_024,
	gatewaySecret: Redacted.make(GATEWAY_SECRET)
});

const makeConnection = (id: string, credential: string) => {
	const frames: Array<SyncApplyFrame> = [];
	const closed: Array<SyncDisconnectReason> = [];
	let writable = true;
	const sink: SyncSink = {
		writable: () => writable,
		write: (frame) => {
			if (!writable) return false;
			frames.push(frame);
			return true;
		},
		close: (reason) => {
			closed.push(reason);
		}
	};
	const connection: SyncConnection = {
		id,
		credential,
		sink,
		subscriptions: new Map(),
		queries: new Map(),
		dirty: new Set(),
		closed: false,
		refreshing: false
	};
	return {
		connection,
		frames,
		closed,
		setWritable: (value: boolean) => {
			writable = value;
		}
	};
};

describe('shared sync registry', () => {
	it('preserves orderBy term precedence while canonicalizing other object keys', () => {
		const registry = makeSyncRegistry(() => undefined);
		const ordered: SyncQueryInput = {
			kind: 'findMany',
			collection: 'steps',
			orderBy: { created_at: 'desc', id: 'asc' }
		};
		const reversed: SyncQueryInput = {
			kind: 'findMany',
			collection: 'steps',
			orderBy: { id: 'asc', created_at: 'desc' }
		};
		assert.notStrictEqual(registry.queryHash(ordered), registry.queryHash(reversed));
		assert.strictEqual(
			registry.queryHash({ collection: 'steps', limit: 20, kind: 'findMany' }),
			registry.queryHash({ kind: 'findMany', collection: 'steps', limit: 20 })
		);
	});
});

/** The guest double: one full answer per query and per affected subscription. */
const makeBridge = (hooks: {
	readonly onConnect?: (request: SyncConnectRequest) => void;
	readonly onAdvance?: (request: SyncAdvanceRequest) => void;
}): SyncGuestBridge => ({
	connect: async ({ request }: { readonly request: SyncConnectRequest }) => {
		hooks.onConnect?.(request);
		return {
			head: { sequence: 1 },
			results: request.queries.map((query) => ({
				key: query.key,
				input: query.input,
				policyHash: 'policy-a',
				// Each query depends on its own collection (plus the policy graph), or every commit
				// wakes every subscription and per-connection targeting can never be observed.
				dependencies: [query.input.collection, 'grants'],
				policyDependencies: ['grants'],
				heldIds: [],
				digestOnly: false,
				digest: `d-${query.key}-0`,
				changed: true,
				answer: [{ id: query.key }]
			})),
			outcomes: []
		};
	},
	advance: async ({ request }: { readonly request: SyncAdvanceRequest }) => {
		hooks.onAdvance?.(request);
		return {
			head: { sequence: 2 },
			updates: request.subscriptions.map((subscription) => ({
				subId: subscription.subId,
				from: subscription.digest,
				to: `d-${subscription.key}-1`,
				patch: { op: 'answer', answer: [{ id: subscription.key }] },
				heldIds: ['held-1'],
				digestOnly: false,
				policyHash: subscription.policyHash,
				dependencies: ['steps', 'grants'],
				policyDependencies: ['grants']
			})),
			refused: [],
			outcomes: request.pending.map((id) => ({
				id,
				status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
			}))
		};
	}
});

const openAndConnect = async (
	host: SyncInterface,
	id: string,
	key: string,
	input: SyncQueryInput,
	credential: string
) => {
	const probe = makeConnection(id, credential);
	host.open({ connectionId: id, credential, sink: probe.connection.sink });
	const handshake = await host.connect({
		connectionId: id,
		credential,
		request: { queries: [{ key, input }], released: [], pending: [] }
	});
	return { probe, handshake };
};

describe('bolt-server sync pump', () => {
	it.effect('fans one apply frame per connection with the writer outcome riding it', () =>
		Effect.gen(function* () {
			const advanceRequests: Array<SyncAdvanceRequest> = [];
			const host = makeSyncHost(
				makeBridge({ onAdvance: (request) => advanceRequests.push(request) })
			);
			const { probe: writer } = yield* Effect.tryPromise(() =>
				openAndConnect(host, 'conn-writer', 'ka', { kind: 'findMany', collection: 'steps' }, 'writer')
			);
			const { probe: reader } = yield* Effect.tryPromise(() =>
				openAndConnect(host, 'conn-reader', 'kb', { kind: 'findMany', collection: 'tasks' }, 'reader')
			);

			yield* Effect.tryPromise(() =>
				host.committed({
					writerConnectionId: 'conn-writer',
					writerCredential: 'writer',
					changes: [{ collection: 'steps', recordId: 'r2' }],
					pending: [CollectionMutationIdempotencyKey.make('w1')]
				})
			);

			assert.strictEqual(writer.frames.length, 1);
			assert.deepStrictEqual(
				writer.frames[0]?.patches.map(({ key, from, to }) => ({ key, from, to })),
				[{ key: "ka", from: "d-ka-0", to: "d-ka-1" }]
			);
			assert.deepStrictEqual(writer.frames[0]?.outcomes, [
				{
					id: CollectionMutationIdempotencyKey.make('w1'),
					status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
				}
			]);
			// A commit that touches none of a connection's queries sends it nothing; the writer alone
			// hears an outcome that is not its row.
			assert.deepStrictEqual(reader.frames, []);
			assert.deepStrictEqual(
				advanceRequests[0]?.subscriptions.map(({ digest, credential }) => ({ digest, credential })),
				[{ digest: 'd-ka-0', credential: 'writer' }]
			);
		})
	);

	it.effect('collapses a slow consumer into one full answer when it drains', () =>
		Effect.gen(function* () {
			const host = makeSyncHost(makeBridge({}));
			const { probe: slow } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'conn-slow',
					'k',
					{ kind: 'findMany', collection: 'steps' },
					'reader'
				)
			);
			slow.setWritable(false);
			yield* Effect.tryPromise(() =>
				host.committed({ changes: [{ collection: 'steps', recordId: 'r2' }], pending: [] })
			);
			assert.strictEqual(slow.frames.length, 0, 'the refused commit frame was not written');
			slow.setWritable(true);
			host.ready('conn-slow');
			// The lane barrier: this commit rides the same serial queue behind the drain, so when it
			// resolves, the collapsed connection has already been re-served.
			yield* Effect.tryPromise(() => host.committed({ changes: [], pending: [] }));
			assert.strictEqual(slow.frames.length, 1, 'one full answer, never the dropped chain');
			assert.deepStrictEqual(
				slow.frames[0]?.patches.map(({ patch }) => patch.op),
				['answer']
			);
		})
	);

	it.effect('re-authenticates a connection when a commit touches a policy dependency', () =>
		Effect.gen(function* () {
			const advanceRequests: Array<SyncAdvanceRequest> = [];
			const connectRequests: Array<SyncConnectRequest> = [];
			const host = makeSyncHost(
				makeBridge({
					onConnect: (request) => connectRequests.push(request),
					onAdvance: (request) => advanceRequests.push(request)
				})
			);
			const { probe } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'conn-policy',
					'k',
					{ kind: 'findMany', collection: 'steps' },
					'reader'
				)
			);
			yield* Effect.tryPromise(() =>
				host.committed({ changes: [{ collection: 'grants', recordId: 'g1' }], pending: [] })
			);
			assert.deepStrictEqual(advanceRequests[0]?.subscriptions, []);
			assert.deepStrictEqual(
				connectRequests[1]?.queries.map(({ key }) => key),
				['k'],
				'the drifted connection refreshes under its re-derived subject'
			);
			assert.deepStrictEqual(
				probe.frames[0]?.patches.map(({ patch }) => patch.op),
				['answer']
			);
		})
	);
});

/** Reads one SSE event of the given name from a standing stream. */
const readSseEvent = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	name: string
): Promise<unknown> => {
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const boundary = buffer.indexOf('\n\n');
		if (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const lines = block.split('\n');
			if (lines.some((line) => line === `event: ${name}`)) {
				const data = lines.find((line) => line.startsWith('data: '));
				assert.ok(data !== undefined, `the ${name} event carries data`);
				return JSON.parse(data.slice('data: '.length));
			}
			continue;
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`stream ended before the ${name} event`);
		buffer += decoder.decode(chunk.value, { stream: true });
	}
};

describe('bolt-server sync wire', () => {
	it.effect('carries a committed write from the command to the standing stream', () =>
		Effect.acquireUseRelease(
			Effect.tryPromise({
				try: () => startApplication({ configuration, facilities: { scope: configuration.scope } }),
				catch: (cause) =>
					cause instanceof ApplicationStartError
						? cause
						: new ApplicationStartError({
								operation: 'BoltServer.Test.start',
								message: 'Server test failed to start',
								cause
							})
			}),
			(application) =>
				Effect.gen(function* () {
					const base = `http://${application.address.host}:${application.address.port}`;
					const stream = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/stream`, { headers: { authorization: 'Bearer writer-1' } })
					);
					assert.strictEqual(stream.status, 200);
					assert.strictEqual(
						stream.headers.get('content-type'),
						'text/event-stream; charset=utf-8'
					);
					const reader = stream.body?.getReader();
					assert.ok(reader !== undefined);

					const ready = yield* Effect.tryPromise(() => readSseEvent(reader, 'ready')).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncReadyFrame))
					);

					const connected = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/connect`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': ready.connectionId
							},
							body: JSON.stringify({
								queries: [
									{ key: 'notes', input: { kind: 'findMany', collection: 'fixture-notes' } }
								],
								released: [],
								pending: []
							})
						})
					);
					assert.strictEqual(connected.status, 200);
					const handshake = yield* Effect.tryPromise(() => connected.json()).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncConnectResponse))
					);
					assert.deepStrictEqual(handshake.results, [
						{
							key: 'notes',
							digest: 'fixture-digest-1',
							digestOnly: false,
							changed: true,
							answer: [{ id: 'note-1' }]
						}
					]);

					const mutation = yield* Effect.tryPromise(() =>
						fetch(`${base}/_bolt/command/test.mutate`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': ready.connectionId
							},
							body: JSON.stringify({ idempotencyKey: 'w-1' })
						})
					);
					assert.strictEqual(mutation.status, 200);

					const apply = yield* Effect.tryPromise(() => readSseEvent(reader, 'apply')).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncApplyFrame))
					);
					assert.deepStrictEqual(apply, {
						head: { sequence: 2 },
						patches: [
							{
								key: 'notes',
								from: 'fixture-digest-1',
								to: 'fixture-digest-2',
								patch: {
									op: 'answer',
									answer: [{ id: 'note-1' }, { id: 'note-2' }]
								}
							}
						],
						outcomes: [
							{
								id: CollectionMutationIdempotencyKey.make('w-1'),
								status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
							}
						]
					});

					const recorded = yield* Effect.tryPromise(() =>
						fetch(`${base}/_bolt/command/test.lastAdvance`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1'
							},
							body: '{}'
						})
					);
					assert.strictEqual(recorded.status, 200);
					const last = (yield* Effect.tryPromise(() => recorded.json())) as {
						readonly signature: string | null;
						readonly timestamp: string | null;
						readonly input: unknown;
					} | null;
					assert.ok(last !== null);
					assert.strictEqual(
						last.signature,
						createHmac('sha256', GATEWAY_SECRET)
							.update(
								systemSignaturePayload({
									timestamp: Number(last.timestamp),
									command: 'sync.advance',
									tenantId: configuration.scope.tenantId,
									input: last.input
								}),
								'utf8'
							)
							.digest('hex')
					);
				}),
			(application) => Effect.promise(() => application.stop())
		)
	);

	it.effect('refuses to dispatch an unsigned sync.advance when no gateway secret is configured', () =>
		Effect.acquireUseRelease(
			Effect.tryPromise({
				try: () =>
					startApplication({
						configuration: ServerConfiguration.make({
							...configuration,
							gatewaySecret: undefined
						}),
						facilities: { scope: configuration.scope }
					}),
				catch: (cause) =>
					cause instanceof ApplicationStartError
						? cause
						: new ApplicationStartError({
								operation: 'BoltServer.Test.start',
								message: 'Server test failed to start',
								cause
							})
			}),
			(application) =>
				Effect.gen(function* () {
					const base = `http://${application.address.host}:${application.address.port}`;
					const stream = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/stream`, { headers: { authorization: 'Bearer writer-1' } })
					);
					const reader = stream.body?.getReader();
					assert.ok(reader !== undefined);
					const ready = yield* Effect.tryPromise(() => readSseEvent(reader, 'ready')).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncReadyFrame))
					);
					const connected = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/connect`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': ready.connectionId
							},
							body: JSON.stringify({
								queries: [
									{ key: 'notes', input: { kind: 'findMany', collection: 'fixture-notes' } }
								],
								released: [],
								pending: []
							})
						})
					);
					assert.strictEqual(connected.status, 200);
					const mutation = yield* Effect.tryPromise(() =>
						fetch(`${base}/_bolt/command/test.mutate`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': ready.connectionId
							},
							body: JSON.stringify({ idempotencyKey: 'w-unsigned' })
						})
					);
					assert.strictEqual(mutation.status, 200);
					const recorded = yield* Effect.tryPromise(() =>
						fetch(`${base}/_bolt/command/test.lastAdvance`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1'
							},
							body: '{}'
						})
					);
					const last = yield* Effect.tryPromise(() => recorded.json());
					assert.strictEqual(last, null);
				}),
			(application) => Effect.promise(() => application.stop())
		)
	);
});
