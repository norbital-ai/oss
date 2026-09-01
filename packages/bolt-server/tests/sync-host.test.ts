import { assert, describe, expect, it } from '@effect/vitest';
import {
	CollectionMutationIdempotencyKey,
	EnvironmentName,
	InvocationScope,
	MAX_SYNC_INITIAL_ANSWER_BYTES,
	MAX_SYNC_OUTBOUND_FRAME_BYTES,
	ReleaseId,
	systemSignaturePayload,
	SyncScopedApplyFrame,
	TenantId,
	type SyncAdvanceRequest,
	type SyncApplyFrame,
	type SyncConnectRequest,
	type SyncExtendPrefixRequest,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { Effect, Redacted, Schema } from 'effect';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApplicationStartError, startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import {
	makeSyncHost,
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

const scopedFrame = (
	frame: SyncApplyFrame,
	scope = configuration.scope
): SyncScopedApplyFrame => ({ scope, frame });

const makeConnection = (id: string, credential: string) => {
	const frames: Array<SyncScopedApplyFrame> = [];
	const closed: Array<SyncDisconnectReason> = [];
	let writable = true;
	const sink: SyncSink = {
		writable: () => writable,
		write: (frame) => {
			if (!writable) return false;
			frames.push(frame);
			return true;
		},
		close: (reason) => closed.push(reason)
	};
	const connection = {
		id,
		credential,
		sink
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

const rowKey = (id: string) => ({ id, order: [id] });

const makeBridge = (hooks: {
	readonly onConnect?: (request: SyncConnectRequest) => void;
	readonly onExtend?: (request: SyncExtendPrefixRequest) => void;
	readonly onAdvance?: (request: SyncAdvanceRequest) => void;
}): SyncGuestBridge => ({
	connect: async ({ request }) => {
		hooks.onConnect?.(request);
		return {
			results: request.queries.map((query) => {
				const id = `${query.queryKey}-1`;
				return {
					key: query.queryKey,
					input: query.input,
					planKey: `plan:${JSON.stringify(query.input)}`,
					version: 1,
					prefixKeys: [rowKey(id)],
					loadedPrefix: 1,
					prefixBytes: 32,
					authorityFingerprint: 'policy-a',
					dependencies: [query.input.collection, 'grants'],
					routing: [],
					rows: [{ id, label: 'initial' }]
				};
			}),
			outcomes: []
		};
	},
	extendPrefix: async ({ request, state }) => {
		hooks.onExtend?.(request);
		const appended = Array.from(
			{ length: request.requestedPrefix - request.loadedPrefix },
			(_, index) => {
				const id = `${request.queryKey}-${request.loadedPrefix + index + 1}`;
				return { id, label: 'extended' };
			}
		);
		return {
			queryKey: request.queryKey,
			version: request.version,
			fromPrefix: request.loadedPrefix,
			toPrefix: request.requestedPrefix,
			rows: appended,
			retainedBytes: state.prefixBytes + 32 * appended.length,
			prefixKeys: [...state.prefixKeys, ...appended.map(({ id }) => rowKey(id))]
		};
	},
	advance: async ({ request }) => {
		hooks.onAdvance?.(request);
		const dataTouched = request.changes.some((change) =>
			request.subscriptions.some((subscription) => subscription.input.collection === change.collection)
		);
		if (!dataTouched && request.changes.length > 0) {
			return {
				updates: [],
				resets: request.subscriptions.map((subscription) => ({
					subId: subscription.subId,
					reason: 'policy-changed' as const
				})),
				outcomes: []
			};
		}
		return {
			updates: request.subscriptions.map((subscription) => {
				const first = subscription.prefixKeys[0];
				if (first === undefined) throw new Error('fixture subscription requires a retained prefix');
				return {
					subId: subscription.subId,
					fromVersion: subscription.version,
					toVersion: subscription.version + 1,
					prefixKeys: subscription.prefixKeys,
					prefixBytes: subscription.prefixBytes,
					deltas: subscription.viewerPrefixes.map((loadedPrefix) => ({
						loadedPrefix,
						delta: {
							removeIds: [],
							put:
								loadedPrefix === 0
									? []
									: [{ id: first.id, index: 0, row: { id: first.id, revised: true } }]
						}
					})),
					authorityFingerprint: subscription.authorityFingerprint,
					dependencies: [subscription.input.collection, 'grants']
				};
			}),
			resets: [],
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
	host.open({ connectionId: id, principal: credential, sink: probe.connection.sink });
	const connected = await host.connect({
		connectionId: id,
		principal: credential,
		scope: configuration.scope,
		credential,
		request: { queries: [{ queryKey: key, input, requestedPrefix: 1 }], detached: [], pending: [] }
	});
	return { probe, connected };
};

const updateChange = (collection: string, id: string) => ({
	collection,
	id,
	operation: 'update' as const,
	before: { id, revised: false },
	after: { id, revised: true }
});

describe('bolt-server Sync v2 host', () => {
	it.effect('registers a browser-owned connection id and returns one versioned prefix', () =>
		Effect.gen(function* () {
			const requests: Array<SyncConnectRequest> = [];
			const host = makeSyncHost(makeBridge({ onConnect: (request) => requests.push(request) }));
			const { probe, connected } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'browser-connection-1',
					'steps',
					{ kind: 'findMany', collection: 'steps' },
					'reader'
				)
			);

			assert.deepStrictEqual(probe.frames, []);
			assert.deepStrictEqual(connected, {
				queries: [
					{
						queryKey: 'steps',
						version: 1,
						rows: [{ id: 'steps-1', label: 'initial' }],
						retainedBytes: 32
					}
				],
				outcomes: []
			});
			assert.deepStrictEqual(requests, [
				{
					queries: [
						{
							queryKey: 'steps',
							input: { kind: 'findMany', collection: 'steps' },
							requestedPrefix: 1
						}
					],
					detached: [],
					pending: []
				}
			]);
		})
	);

	it.effect('extends one attached prefix monotonically without emitting a stream frame', () =>
		Effect.gen(function* () {
			const requests: Array<SyncExtendPrefixRequest> = [];
			const host = makeSyncHost(makeBridge({ onExtend: (request) => requests.push(request) }));
			const { probe } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'browser-connection-2',
					'steps',
					{ kind: 'findMany', collection: 'steps' },
					'reader'
				)
			);
			const request = {
				queryKey: 'steps',
				version: 1,
				loadedPrefix: 1,
				requestedPrefix: 2
			};
			const response = yield* Effect.tryPromise(() =>
				host.extendPrefix({
					connectionId: 'browser-connection-2',
					principal: 'reader',
					scope: configuration.scope,
					credential: 'reader',
					request
				})
			);

			assert.deepStrictEqual(response, {
				queryKey: 'steps',
				version: 1,
				fromPrefix: 1,
				toPrefix: 2,
				rows: [{ id: 'steps-2', label: 'extended' }],
				retainedBytes: 64
			});
			assert.deepStrictEqual(requests, [request]);
			assert.deepStrictEqual(probe.frames, []);
		})
	);

	it.effect('fans versioned deltas only to affected viewers and settles the writer outcome', () =>
		Effect.gen(function* () {
			const advanceRequests: Array<SyncAdvanceRequest> = [];
			const host = makeSyncHost(
				makeBridge({ onAdvance: (request) => advanceRequests.push(request) })
			);
			const { probe: writer } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'conn-writer',
					'steps',
					{ kind: 'findMany', collection: 'steps' },
					'writer'
				)
			);
			const { probe: bystander } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'conn-bystander',
					'tasks',
					{ kind: 'findMany', collection: 'tasks' },
					'reader'
				)
			);

			yield* Effect.tryPromise(() =>
				host.committed({
					scope: configuration.scope,
					writerConnectionId: 'conn-writer',
					writerCredential: 'writer',
					changes: [updateChange('steps', 'steps-1')],
					pending: [CollectionMutationIdempotencyKey.make('write-1')]
				})
			);

			assert.deepStrictEqual(writer.frames, [
				scopedFrame({
					updates: [
						{
							queryKey: 'steps',
							fromVersion: 1,
							toVersion: 2,
							delta: {
								removeIds: [],
								put: [
									{
										id: 'steps-1',
										index: 0,
										row: { id: 'steps-1', revised: true }
									}
								]
							}
						}
					],
					resets: [],
					outcomes: [
						{
							id: CollectionMutationIdempotencyKey.make('write-1'),
							status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
						}
					]
				})
			]);
			assert.deepStrictEqual(bystander.frames, []);
			assert.deepStrictEqual(advanceRequests[0]?.changes, [updateChange('steps', 'steps-1')]);
			assert.deepStrictEqual(advanceRequests[0]?.writer, { credential: 'writer' });
		})
	);

	it.effect('emits a policy reset and retires the affected query', () =>
		Effect.gen(function* () {
			const host = makeSyncHost(makeBridge({}));
			const { probe } = yield* Effect.tryPromise(() =>
				openAndConnect(
					host,
					'conn-policy',
					'steps',
					{ kind: 'findMany', collection: 'steps' },
					'reader'
				)
			);
			yield* Effect.tryPromise(() =>
				host.committed({
					scope: configuration.scope,
					changes: [updateChange('grants', 'grant-1')],
					pending: []
				})
			);

			assert.deepStrictEqual(probe.frames, [
				scopedFrame({
					updates: [],
					resets: [{ queryKey: 'steps', reason: 'policy-changed' }],
					outcomes: []
				})
			]);
			yield* Effect.tryPromise(() =>
				expect(
					host.extendPrefix({
						connectionId: 'conn-policy',
						principal: 'reader',
						scope: configuration.scope,
						credential: 'reader',
						request: { queryKey: 'steps', version: 1, loadedPrefix: 1, requestedPrefix: 2 }
					})
				).rejects.toThrow(/not available|reset/u)
			);
		})
	);

	it('closes before admitting an oversized initial prefix', async () => {
		const baseline = makeBridge({});
		const host = makeSyncHost({
			...baseline,
			connect: async ({ request }) => ({
				results: request.queries.map((query) => ({
					key: query.queryKey,
					input: query.input,
					planKey: 'oversized-plan',
					version: 1,
					prefixKeys: [rowKey('r1')],
					loadedPrefix: 1,
					prefixBytes: 32,
					authorityFingerprint: 'policy-a',
					dependencies: [query.input.collection],
					routing: [],
					rows: [{ id: 'r1', payload: 'x'.repeat(MAX_SYNC_INITIAL_ANSWER_BYTES) }]
				})),
				outcomes: []
			})
		});
		const probe = makeConnection('oversized-open', 'reader');
		host.open({
			connectionId: probe.connection.id,
			principal: probe.connection.credential,
			sink: probe.connection.sink
		});

		await expect(
			host.connect({
				connectionId: probe.connection.id,
				principal: probe.connection.credential,
				scope: configuration.scope,
				credential: probe.connection.credential,
				request: {
					queries: [
						{
							queryKey: 'steps',
							input: { kind: 'findMany', collection: 'steps' },
							requestedPrefix: 1
						}
					],
					detached: [],
					pending: []
				}
			})
		).rejects.toThrow(/encoded byte ceiling/u);
		assert.deepStrictEqual(probe.frames, []);
		assert.deepStrictEqual(probe.closed, ['guest-failed']);
	});

	it('closes a consumer before an oversized apply frame reaches its sink', async () => {
		const baseline = makeBridge({});
		const host = makeSyncHost({
			...baseline,
			advance: async ({ request }) => ({
				updates: request.subscriptions.map((subscription) => ({
					subId: subscription.subId,
					fromVersion: subscription.version,
					toVersion: subscription.version + 1,
					prefixKeys: subscription.prefixKeys,
					prefixBytes: subscription.prefixBytes,
					deltas: subscription.viewerPrefixes.map((loadedPrefix) => ({
						loadedPrefix,
						delta: {
							removeIds: [],
							put: [
								{
									id: subscription.prefixKeys[0]?.id ?? 'r1',
									index: 0,
									row: {
										id: subscription.prefixKeys[0]?.id ?? 'r1',
										payload: 'x'.repeat(MAX_SYNC_OUTBOUND_FRAME_BYTES)
									}
								}
							]
						}
					})),
					authorityFingerprint: subscription.authorityFingerprint,
					dependencies: ['steps']
				})),
				resets: [],
				outcomes: []
			})
		});
		const { probe } = await openAndConnect(
			host,
			'oversized-frame',
			'steps',
			{ kind: 'findMany', collection: 'steps' },
			'reader'
		);

		await host.committed({
			scope: configuration.scope,
			changes: [updateChange('steps', 'steps-1')],
			pending: []
		});
		assert.deepStrictEqual(probe.frames, []);
		assert.deepStrictEqual(probe.closed, ['guest-failed']);
	});

	it('multiplexes scope-qualified workspace lanes over one physical browser connection', async () => {
		const host = makeSyncHost(makeBridge({}));
		const probe = makeConnection('one-browser-profile', 'reader');
		const secondScope = InvocationScope.make({
			tenantId: TenantId.make('server-test-secondary'),
			environment: EnvironmentName.make('test'),
			releaseId: ReleaseId.make('server-test-secondary')
		});
		host.open({
			connectionId: probe.connection.id,
			principal: 'reader',
			sink: probe.connection.sink
		});
		await host.connect({
			connectionId: probe.connection.id,
			principal: 'reader',
			scope: configuration.scope,
			credential: 'reader',
			request: {
				queries: [
					{
						queryKey: 'primary-steps',
						input: { kind: 'findMany', collection: 'steps' },
						requestedPrefix: 1
					}
				],
				detached: [],
				pending: []
			}
		});
		await host.connect({
			connectionId: probe.connection.id,
			principal: 'reader',
			scope: secondScope,
			credential: 'reader',
			request: {
				queries: [
					{
						queryKey: 'secondary-tasks',
						input: { kind: 'findMany', collection: 'tasks' },
						requestedPrefix: 1
					}
				],
				detached: [],
				pending: []
			}
		});

		await host.committed({
			scope: configuration.scope,
			changes: [updateChange('steps', 'primary-steps-1')],
			pending: []
		});
		await host.committed({
			scope: secondScope,
			changes: [updateChange('tasks', 'secondary-tasks-1')],
			pending: []
		});

		assert.deepStrictEqual(
			probe.frames.map(({ scope }) => scope),
			[configuration.scope, secondScope]
		);
		assert.deepStrictEqual(
			probe.frames.map(({ frame }) => frame.updates[0]?.queryKey),
			['primary-steps', 'secondary-tasks']
		);
		assert.deepStrictEqual(probe.closed, []);
	});

	it('keeps same-principal physical connections independent across browser profiles and devices', async () => {
		const host = makeSyncHost(makeBridge({}));
		const { probe: laptop } = await openAndConnect(
			host,
			'profile-laptop',
			'steps',
			{ kind: 'findMany', collection: 'steps' },
			'same-principal'
		);
		const { probe: phone } = await openAndConnect(
			host,
			'device-phone',
			'steps',
			{ kind: 'findMany', collection: 'steps' },
			'same-principal'
		);

		await host.committed({
			scope: configuration.scope,
			changes: [updateChange('steps', 'steps-1')],
			pending: []
		});
		assert.strictEqual(laptop.frames.length, 1);
		assert.strictEqual(phone.frames.length, 1);
		assert.deepStrictEqual(laptop.closed, []);
		assert.deepStrictEqual(phone.closed, []);

		host.detach('profile-laptop');
		assert.deepStrictEqual(laptop.closed, ['client']);
		assert.deepStrictEqual(phone.closed, []);
	});

	it('rejects control traffic whose principal does not own the physical connection', async () => {
		const host = makeSyncHost(makeBridge({}));
		const probe = makeConnection('principal-bound', 'owner');
		host.open({
			connectionId: probe.connection.id,
			principal: 'owner',
			sink: probe.connection.sink
		});
		await expect(
			host.connect({
				connectionId: probe.connection.id,
				principal: 'different-principal',
				scope: configuration.scope,
				credential: 'owner',
				request: {
					queries: [
						{
							queryKey: 'steps',
							input: { kind: 'findMany', collection: 'steps' },
							requestedPrefix: 1
						}
					],
					detached: [],
					pending: []
				}
			})
		).rejects.toThrow(/not available/u);
		assert.deepStrictEqual(probe.closed, []);
	});

	it('detaches non-writable consumers and closes browser replacement streams', async () => {
		const host = makeSyncHost(makeBridge({}));
		const { probe: slow } = await openAndConnect(
			host,
			'connection-reused',
			'steps',
			{ kind: 'findMany', collection: 'steps' },
			'reader'
		);
		slow.setWritable(false);
		await host.committed({
			scope: configuration.scope,
			changes: [updateChange('steps', 'steps-1')],
			pending: []
		});
		assert.deepStrictEqual(slow.frames, []);
		assert.deepStrictEqual(slow.closed, ['guest-failed']);

		const previous = makeConnection('replacement', 'reader');
		const replacement = makeConnection('replacement', 'reader');
		host.open({
			connectionId: 'replacement',
			principal: 'reader',
			sink: previous.connection.sink
		});
		host.open({
			connectionId: 'replacement',
			principal: 'reader',
			sink: replacement.connection.sink
		});
		assert.deepStrictEqual(previous.closed, ['client']);
		assert.deepStrictEqual(replacement.closed, []);
		host.detach('replacement');
		assert.deepStrictEqual(replacement.closed, ['client']);
	});
});

const readNextSseEvent = async (
	reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ readonly event: string; readonly data: unknown }> => {
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const boundary = buffer.indexOf('\n\n');
		if (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const lines = block.split('\n');
			const event = lines.find((line) => line.startsWith('event: '));
			if (event === undefined) continue;
			const data = lines.find((line) => line.startsWith('data: '));
			assert.ok(data !== undefined, 'a named SSE event carries data');
			return {
				event: event.slice('event: '.length),
				data: JSON.parse(data.slice('data: '.length))
			};
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error('stream ended before the next named event');
		buffer += decoder.decode(chunk.value, { stream: true });
	}
};

const startTestApplication = (serverConfiguration: ServerConfiguration) =>
	Effect.tryPromise({
		try: () =>
			startApplication({
				configuration: serverConfiguration,
				facilities: { scope: serverConfiguration.scope }
			}),
		catch: (cause) =>
			cause instanceof ApplicationStartError
				? cause
				: new ApplicationStartError({
						operation: 'BoltServer.Test.start',
						message: 'Server test failed to start',
						cause
					})
	});

describe('bolt-server Sync v2 wire', () => {
	it.effect('opens with a browser id, registers separately, extends, and emits scoped apply first', () =>
		Effect.acquireUseRelease(
			startTestApplication(configuration),
			(application) =>
				Effect.gen(function* () {
					const base = `http://${application.address.host}:${application.address.port}`;
					const connectionId = 'browser-writer-1';
					const stream = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/stream?connectionId=${encodeURIComponent(connectionId)}`, {
							headers: { authorization: 'Bearer writer-1' }
						})
					);
					assert.strictEqual(stream.status, 200);
					assert.strictEqual(
						stream.headers.get('content-type'),
						'text/event-stream; charset=utf-8'
					);
					const reader = stream.body?.getReader();
					assert.ok(reader !== undefined);

					const connected = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/connect`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': connectionId
							},
							body: JSON.stringify({
								queries: [
									{
										queryKey: 'notes',
										input: { kind: 'findMany', collection: 'fixture-notes' },
										requestedPrefix: 1
									}
								],
								detached: [],
								pending: []
							})
						})
					);
					assert.strictEqual(connected.status, 200);
					assert.deepStrictEqual(yield* Effect.tryPromise(() => connected.json()), {
						queries: [
							{
								queryKey: 'notes',
								version: 1,
								rows: [{ id: 'note-1' }],
								retainedBytes: 20
							}
						],
						outcomes: []
					});

					const extended = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/extend`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': connectionId
							},
							body: JSON.stringify({
								queryKey: 'notes',
								version: 1,
								loadedPrefix: 1,
								requestedPrefix: 2
							})
						})
					);
					assert.strictEqual(extended.status, 200);
					assert.deepStrictEqual(yield* Effect.tryPromise(() => extended.json()), {
						queryKey: 'notes',
						version: 1,
						fromPrefix: 1,
						toPrefix: 2,
						rows: [{ id: 'note-2' }],
						retainedBytes: 40
					});

					const mutation = yield* Effect.tryPromise(() =>
						fetch(`${base}/_bolt/command/test.mutate`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': connectionId
							},
							body: JSON.stringify({ idempotencyKey: 'write-wire-1' })
						})
					);
					assert.strictEqual(mutation.status, 200);

					const firstEvent = yield* Effect.tryPromise(() => readNextSseEvent(reader));
					assert.strictEqual(firstEvent.event, 'apply');
					const apply = yield* Schema.decodeUnknownEffect(SyncScopedApplyFrame)(firstEvent.data);
					assert.deepStrictEqual(apply, scopedFrame({
						updates: [
							{
								queryKey: 'notes',
								fromVersion: 1,
								toVersion: 2,
								delta: {
									removeIds: [],
									put: [
										{
											id: 'note-1',
											index: 0,
											row: { id: 'note-1', revised: true }
										}
									]
								}
							}
						],
						resets: [],
						outcomes: [
							{
								id: CollectionMutationIdempotencyKey.make('write-wire-1'),
								status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
							}
						]
					}));

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
					yield* Effect.tryPromise(() => reader.cancel());
				}),
			(application) => Effect.promise(() => application.stop())
		)
	);

	it.effect('refuses an unsigned sync.advance when no gateway secret is configured', () =>
		Effect.acquireUseRelease(
			startTestApplication(
				ServerConfiguration.make({ ...configuration, gatewaySecret: undefined })
			),
			(application) =>
				Effect.gen(function* () {
					const base = `http://${application.address.host}:${application.address.port}`;
					const connectionId = 'browser-unsigned-1';
					const stream = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/stream?connectionId=${encodeURIComponent(connectionId)}`, {
							headers: { authorization: 'Bearer writer-1' }
						})
					);
					const reader = stream.body?.getReader();
					assert.ok(reader !== undefined);
					const connected = yield* Effect.tryPromise(() =>
						fetch(`${base}/sync/connect`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: 'Bearer writer-1',
								'x-bolt-sync-connection': connectionId
							},
							body: JSON.stringify({
								queries: [
									{
										queryKey: 'notes',
										input: { kind: 'findMany', collection: 'fixture-notes' },
										requestedPrefix: 1
									}
								],
								detached: [],
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
								'x-bolt-sync-connection': connectionId
							},
							body: JSON.stringify({ idempotencyKey: 'write-unsigned' })
						})
					);
					assert.strictEqual(mutation.status, 500);

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
					assert.strictEqual(yield* Effect.tryPromise(() => recorded.json()), null);
					yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore);
				}),
			(application) => Effect.promise(() => application.stop())
		)
	);
});
