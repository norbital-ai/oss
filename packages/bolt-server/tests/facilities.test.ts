import { assert, it } from '@effect/vitest';
import type { Schema } from 'effect';
import {
	AIRequest,
	CommunicationRequest,
	ConnectorRequest,
	DatabaseRequest,
	EffectId,
	FileRequest,
	HostToolRequest,
	InvocationId,
	ModelId,
	ProviderCallId,
	ReleaseId,
	TaskRequest,
	TransportRequest
} from '@norbital-ai/bolt-protocol';
import { ConfigProvider, Effect } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAiBinding, makeAiBindingFromConfig } from '../src/facilities/providers.js';
import {
	makeCommunicationBinding,
	makeCommunicationBindingFromConfig
} from '../src/facilities/providers.js';
import {
	makeConnectorBinding,
	makeConnectorBindingFromConfig
} from '../src/facilities/providers.js';
import {
	databaseFailureRetryable,
	databaseSqlState,
	makeDatabaseFromConfig,
	makeLocalDatabase
} from '../src/facilities/database.js';
import { makeFilesBindingFromConfig, makeLocalFilesBinding } from '../src/facilities/files.js';
import { makeHostToolBinding, makeHostToolBindingFromConfig } from '../src/facilities/providers.js';
import { makeTaskBinding, makeTaskInvocationControl } from '../src/schedules.js';
import { makeTimekeeper } from '../src/timekeeper.js';
import { makeMemoryTransport } from '../src/facilities/transport.js';

const metadata = {
	invocationId: InvocationId.make('invocation-1'),
	effectId: EffectId.make('effect-1'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	idempotencyKey: 'stable-1'
};

const signal = new AbortController().signal;
const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 30_000;
const withConfiguration = (values: Record<string, string>) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(values));

/**
 * A row crosses the facility boundary as `Json`, so it is narrowed before it is indexed rather than
 * asserted into a shape the type does not promise. Written as a predicate because `Array.isArray`
 * does not narrow the readonly array arm of `Json` away on its own.
 */
const isJsonObject = (
	value: Schema.Json | undefined
): value is Readonly<Record<string, Schema.Json>> =>
	value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

it('classifies serialization SQLSTATE through driver wrappers without changing other failures', () => {
	assert.strictEqual(databaseSqlState({ cause: { error: { code: '40001' } } }), '40001');
	assert.strictEqual(databaseFailureRetryable({ cause: { code: '40001' } }), true);
	assert.strictEqual(databaseFailureRetryable({ cause: { code: '23505' } }), undefined);
	assert.strictEqual(databaseFailureRetryable(new Error('network unavailable')), undefined);
});

it.effect(
	'restores a committed backup independently while its source remains open',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => makeLocalDatabase({ dataDirectory: 'memory://' })),
			(database) =>
				Effect.gen(function* () {
					const query = (sql: string) =>
						Effect.tryPromise(() =>
							database.binding.call(
								metadata,
								DatabaseRequest.cases.Query.make({ sql, parameters: [] }),
								signal
							)
						);
					yield* query('create table backup_probe (id integer primary key, value text not null)');
					yield* query("insert into backup_probe values (1, 'before')");
					const backup = yield* Effect.tryPromise(database.dumpDataDirectory);
					yield* query("update backup_probe set value = 'after' where id = 1");
					yield* Effect.acquireUseRelease(
						Effect.tryPromise(() =>
							makeLocalDatabase({ dataDirectory: 'memory://', loadDataDirectory: backup })
						),
						(restored) =>
							Effect.gen(function* () {
								const result = yield* Effect.tryPromise(() =>
									restored.binding.call(
										metadata,
										DatabaseRequest.cases.Query.make({
											sql: 'select * from backup_probe',
											parameters: []
										}),
										signal
									)
								);
								assert.deepStrictEqual(result, {
									_tag: 'Success',
									value: { rows: [{ id: 1, value: 'before' }], affectedRows: 0 }
								});
							}),
						(restored) => Effect.promise(restored.close)
					);
					assert.deepStrictEqual(yield* query('select * from backup_probe'), {
						_tag: 'Success',
						value: { rows: [{ id: 1, value: 'after' }], affectedRows: 0 }
					});
				}),
			(database) => Effect.promise(database.close)
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect(
	'reports the driver refusal and rolls back a failed data migration',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => makeLocalDatabase({ dataDirectory: 'memory://' })),
			(database) =>
				Effect.gen(function* () {
					const call = (request: DatabaseRequest) =>
						Effect.tryPromise(() => database.binding.call(metadata, request, signal));
					yield* call(
						DatabaseRequest.cases.Query.make({
							sql: 'create table migration_proof (id integer)',
							parameters: []
						})
					);
					const failed = yield* call(
						DatabaseRequest.cases.Transaction.make({
							statements: [
								{ sql: 'insert into migration_proof values (1)', parameters: [] },
								{ sql: 'select missing_field from migration_proof', parameters: [] }
							]
						})
					);
					assert.strictEqual(failed._tag, 'Failure');
					if (failed._tag === 'Failure')
						assert.match(failed.error.message, /column "missing_field" does not exist/);
					const remaining = yield* call(
						DatabaseRequest.cases.Query.make({
							sql: 'select * from migration_proof',
							parameters: []
						})
					);
					assert.deepStrictEqual(remaining, {
						_tag: 'Success',
						value: { rows: [], affectedRows: 0 }
					});
				}),
			(database) => Effect.promise(database.close)
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect(
	'returns a retryable facility failure for bolt_assert serialization conflicts',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => makeLocalDatabase({ dataDirectory: 'memory://' })),
			(database) =>
				Effect.gen(function* () {
					yield* Effect.tryPromise(() =>
						database.binding.call(
							metadata,
							DatabaseRequest.cases.Query.make({
								sql: "create or replace function bolt_assert(ok boolean, message text) returns void language plpgsql as $$ begin if ok is not true then raise exception '%', message using errcode = '40001'; end if; end $$",
								parameters: []
							}),
							signal
						)
					);
					const result = yield* Effect.tryPromise(() =>
						database.binding.call(
							metadata,
							DatabaseRequest.cases.Transaction.make({
								statements: [{ sql: "select bolt_assert(false, 'graph changed')", parameters: [] }]
							}),
							signal
						)
					);
					assert.strictEqual(result._tag, 'Failure');
					if (result._tag === 'Failure') {
						assert.strictEqual(result.error.retryable, true);
					}
				}),
			(database) => Effect.tryPromise(() => database.close()).pipe(Effect.ignore)
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect(
	'executes local PostgreSQL-compatible query and transaction calls',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => makeLocalDatabase({ dataDirectory: 'memory://' })),
			(database) =>
				Effect.gen(function* () {
					yield* Effect.tryPromise(() =>
						database.binding.call(
							metadata,
							DatabaseRequest.cases.Query.make({
								sql: 'create table proof (id integer primary key, label text not null)',
								parameters: []
							}),
							signal
						)
					);
					const inserted = yield* Effect.tryPromise(() =>
						database.binding.call(
							metadata,
							DatabaseRequest.cases.Transaction.make({
								statements: [
									{ sql: 'insert into proof values ($1, $2)', parameters: [1, 'one'] },
									{ sql: 'select * from proof order by id', parameters: [] }
								]
							}),
							signal
						)
					);
					assert.deepStrictEqual(inserted, {
						_tag: 'Success',
						value: { rows: [{ id: 1, label: 'one' }], affectedRows: 1 }
					});
				}),
			(database) => Effect.promise(database.close)
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect(
	'returns JSON-safe timestamps from local PGlite queries',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => makeLocalDatabase({ dataDirectory: 'memory://' })),
			(database) =>
				Effect.gen(function* () {
					const response = yield* Effect.tryPromise(() =>
						database.binding.call(
							metadata,
							DatabaseRequest.cases.Query.make({ sql: 'select now() as ts', parameters: [] }),
							signal
						)
					);
					assert.strictEqual(response._tag, 'Success');
					if (response._tag !== 'Success') return;
					// A row crosses the facility boundary as `Json`, so it is narrowed before it is indexed
					// rather than asserted into a shape the type does not actually promise.
					const [row] = response.value.rows;
					if (!isJsonObject(row))
						throw new Error(`expected a row object, received ${JSON.stringify(row)}`);
					const ts = row['ts'];
					assert.strictEqual(typeof ts, 'string');
					assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T/);
				}),
			(database) => Effect.promise(database.close)
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect('executes memory transport Open, Send, Pull, and Close', () =>
	Effect.gen(function* () {
		const transport = makeMemoryTransport();
		const opened = yield* Effect.tryPromise(() =>
			transport.binding.call(metadata, TransportRequest.cases.Open.make({}), signal)
		);
		assert.strictEqual(opened._tag, 'Success');
		if (opened._tag !== 'Success') return;
		const connectionId = opened.value.connectionId;
		assert.notStrictEqual(connectionId, undefined);
		assert.strictEqual(transport.activeConnections(), 1);

		const sent = yield* Effect.tryPromise(() =>
			transport.binding.call(
				metadata,
				TransportRequest.cases.Send.make({
					connectionId: connectionId ?? '',
					kind: 'text',
					bytes: new TextEncoder().encode('hello transport')
				}),
				signal
			)
		);
		assert.strictEqual(sent._tag, 'Success');

		const pulled = yield* Effect.tryPromise(() =>
			transport.binding.call(
				metadata,
				TransportRequest.cases.Pull.make({ connectionId: connectionId ?? '', maxFrames: 16 }),
				signal
			)
		);
		assert.strictEqual(pulled._tag, 'Success');
		if (pulled._tag !== 'Success') return;
		assert.strictEqual(pulled.value.frames?.length, 1);
		assert.strictEqual(
			new TextDecoder().decode(pulled.value.frames?.[0]?.bytes ?? new Uint8Array()),
			'hello transport'
		);

		const closed = yield* Effect.tryPromise(() =>
			transport.binding.call(
				metadata,
				TransportRequest.cases.Close.make({ connectionId: connectionId ?? '' }),
				signal
			)
		);
		assert.strictEqual(closed._tag, 'Success');
		assert.strictEqual(closed._tag === 'Success' && closed.value.closed, true);

		yield* Effect.promise(transport.close);
		assert.strictEqual(transport.activeConnections(), 0);
	})
);

/**
 * The other half of the sync engine's push path.
 *
 * A stateless invocation never held the browser's connection, so it addresses the topic instead. What
 * matters is that the frame lands on every connection listening to that topic and on no other, and
 * that reaching nobody is an ordinary answer rather than a failure — a workspace with no open tab is
 * the common case.
 */
it.effect('fans a memory transport Publish out to the topic, and only that topic', () =>
	Effect.gen(function* () {
		const transport = makeMemoryTransport();
		const open = (topic: string) =>
			Effect.tryPromise(() =>
				transport.binding.call(metadata, TransportRequest.cases.Open.make({ topic }), signal)
			);
		const idOf = (result: {
			readonly _tag: string;
			readonly value?: { readonly connectionId?: string };
		}) => result.value?.connectionId ?? '';

		const listenerA = idOf(yield* open('bolt.sync'));
		const listenerB = idOf(yield* open('bolt.sync'));
		const bystander = idOf(yield* open('something.else'));

		const published = yield* Effect.tryPromise(() =>
			transport.binding.call(
				metadata,
				TransportRequest.cases.Publish.make({
					topic: 'bolt.sync',
					kind: 'text',
					bytes: new TextEncoder().encode('{"collections":["people"]}')
				}),
				signal
			)
		);
		assert.strictEqual(published._tag, 'Success');
		if (published._tag !== 'Success') return;
		assert.strictEqual(published.value.delivered, 2);

		const pull = (connectionId: string) =>
			Effect.tryPromise(() =>
				transport.binding.call(
					metadata,
					TransportRequest.cases.Pull.make({ connectionId, maxFrames: 16 }),
					signal
				)
			);
		for (const connectionId of [listenerA, listenerB]) {
			const pulled = yield* pull(connectionId);
			assert.strictEqual(pulled._tag, 'Success');
			if (pulled._tag !== 'Success') return;
			assert.strictEqual(pulled.value.frames?.length, 1);
			assert.strictEqual(
				new TextDecoder().decode(pulled.value.frames?.[0]?.bytes ?? new Uint8Array()),
				'{"collections":["people"]}'
			);
		}
		// A tenant listening on another topic must not learn that this one changed.
		const unrelated = yield* pull(bystander);
		assert.strictEqual(unrelated._tag === 'Success' && (unrelated.value.frames?.length ?? 0), 0);

		const toNobody = yield* Effect.tryPromise(() =>
			transport.binding.call(
				metadata,
				TransportRequest.cases.Publish.make({
					topic: 'nobody.here',
					kind: 'text',
					bytes: new TextEncoder().encode('{}')
				}),
				signal
			)
		);
		// Reported, not failed: the write it announces has already committed.
		assert.strictEqual(toNobody._tag, 'Success');
		assert.strictEqual(toNobody._tag === 'Success' && toNobody.value.delivered, 0);

		yield* Effect.promise(transport.close);
	})
);

it.effect('keeps local file keys under the configured root', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'bolt-server-files-'))),
		(root) =>
			Effect.gen(function* () {
				const files = makeLocalFilesBinding({ rootDirectory: root });
				const written = yield* Effect.tryPromise(() =>
					files.call(
						metadata,
						FileRequest.cases.Write.make({
							key: 'documents/proof.txt',
							bytes: new TextEncoder().encode('proof')
						}),
						signal
					)
				);
				assert.strictEqual(written._tag, 'Success');

				const read = yield* Effect.tryPromise(() =>
					files.call(metadata, FileRequest.cases.Read.make({ key: 'documents/proof.txt' }), signal)
				);
				assert.strictEqual(
					read._tag === 'Success' && read.value.bytes !== undefined
						? new TextDecoder().decode(read.value.bytes)
						: undefined,
					'proof'
				);
				const listed = yield* Effect.tryPromise(() =>
					files.call(metadata, FileRequest.cases.List.make({ prefix: 'documents' }), signal)
				);
				assert.deepStrictEqual(listed, {
					_tag: 'Success',
					value: { keys: ['documents/proof.txt'] }
				});

				const escaped = yield* Effect.tryPromise(() =>
					files.call(metadata, FileRequest.cases.Read.make({ key: '../outside.txt' }), signal)
				);
				assert.strictEqual(escaped._tag, 'Failure');
			}),
		(root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
	)
);

it.effect('loads production database and file providers through Effect Config', () =>
	Effect.acquireUseRelease(
		Effect.gen(function* () {
			const database = yield* makeDatabaseFromConfig();
			const files = yield* makeFilesBindingFromConfig();
			return { database, files };
		}).pipe(
			Effect.provide(
				withConfiguration({
					BOLT_SERVER_DATABASE_PROVIDER: 'postgres',
					BOLT_SERVER_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
					BOLT_SERVER_DATABASE_SSL: 'false',
					BOLT_SERVER_FILES_PROVIDER: 'local',
					BOLT_SERVER_FILES_ROOT: '/tmp/bolt-server-configured-files'
				})
			)
		),
		({ database, files }) =>
			Effect.gen(function* () {
				const controller = new AbortController();
				controller.abort(new Error('cancelled before connection'));
				const response = yield* Effect.tryPromise(() =>
					database.binding.call(
						metadata,
						DatabaseRequest.cases.Query.make({ sql: 'select 1', parameters: [] }),
						controller.signal
					)
				);
				assert.strictEqual(response._tag, 'Failure');
				assert.strictEqual(typeof files.call, 'function');
			}),
		({ database }) => Effect.promise(database.close)
	)
);

it.effect('adapts AI, communication, connector, task and host-tool providers', () =>
	Effect.gen(function* () {
		const ai = makeAiBinding({
			call: async () => ({
				_tag: 'Catalog',
				languageModels: [{ id: 'test/language' }],
				defaultLanguageModelId: 'test/language',
				embeddingModels: [{ id: 'test/embedding' }],
				defaultEmbeddingModelId: 'test/embedding'
			})
		});
		const communication = makeCommunicationBinding({
			call: async () => ({ receipt: { id: 'message-1' } })
		});
		const connector = makeConnectorBinding({
			call: async (_metadata, input) => ({ output: { operation: input.operation } })
		});
		const registered: Array<string> = [];
		const tasks = makeTaskBinding(
			makeTimekeeper({
				tick: () => Effect.succeed(null),
				run: Effect.runPromise,
				onFailure: () => {}
			}),
			(command) => registered.push(command)
		);
		const hostTools = makeHostToolBinding({
			call: async (_metadata, input) => ({ output: { tool: input.tool } })
		});

		const results = yield* Effect.all([
			Effect.tryPromise(() => ai.call(metadata, AIRequest.cases.Catalog.make({}), signal)),
			Effect.tryPromise(() =>
				communication.call(
					metadata,
					CommunicationRequest.cases.Send.make({
						channel: 'test',
						recipient: 'user-1',
						payload: { text: 'hello' }
					}),
					signal
				)
			),
			Effect.tryPromise(() =>
				connector.call(
					metadata,
					ConnectorRequest.make({ connector: 'test', operation: 'read', input: {} }),
					signal
				)
			),
			// The task facility is a timer now: `Register` says where to route work for this release,
			// and `Wake` asks the host to come back no later than an instant.
			Effect.tryPromise(() =>
				tasks.call(
					metadata,
					TaskRequest.cases.Register.make({
						releaseId: ReleaseId.make('release-1'),
						command: 'notifications.drain'
					}),
					signal
				)
			),
			Effect.tryPromise(() =>
				tasks.call(
					metadata,
					TaskRequest.cases.Wake.make({ notLaterThanEpochMs: Date.now() + 1_000 }),
					signal
				)
			),
			Effect.tryPromise(() =>
				hostTools.call(
					metadata,
					HostToolRequest.make({ tool: 'workspace.inspect', input: {} }),
					signal
				)
			)
		]);
		assert.deepStrictEqual(
			results.map((result) => result._tag),
			['Success', 'Success', 'Success', 'Success', 'Success', 'Success']
		);
		assert.deepStrictEqual(registered, ['notifications.drain']);
	})
);

it.effect('preserves agent tool definitions through the standalone AI provider boundary', () =>
	Effect.gen(function* () {
		let received: AIRequest | undefined;
		const ai = makeAiBinding({
			call: async (_metadata, input) => {
				received = input;
				if (input._tag !== 'Generate') throw new Error('Expected generation');
				return {
					_tag: 'Generated',
					result: {
						_tag: 'Message',
						message: { role: 'assistant', content: 'Ready.', options: {} }
					},
					observation: {
						callId: input.callId,
						provider: 'test',
						model: input.modelId,
						operation: 'language'
					}
				};
			}
		});
		const request = AIRequest.cases.Generate.make({
			callId: ProviderCallId.make('tool-schema'),
			modelId: ModelId.make('test/language'),
			messages: [],
			maxOutputTokens: 100,
			output: {
				_tag: 'Message',
				tools: [
					{
						name: 'read_collection',
						description: 'Read authorized rows.',
						inputSchema: {
							type: 'object',
							properties: { collection: { type: 'string' } },
							required: ['collection'],
							additionalProperties: false
						}
					}
				]
			}
		});
		const result = yield* Effect.tryPromise(() => ai.call(metadata, request, signal));
		assert.strictEqual(result._tag, 'Success');
		assert.deepEqual(received, request);
	})
);

it.effect('interrupts only the exact active task dispatch and forgets settled pointers', () =>
	Effect.gen(function* () {
		const invocations = makeTaskInvocationControl();
		const tasks = makeTaskBinding(
			makeTimekeeper({
				tick: () => Effect.succeed(null),
				run: Effect.runPromise,
				onFailure: () => {}
			}),
			() => {},
			invocations
		);
		const activeInvocation = InvocationId.make('active-invocation');
		const controlInvocation = InvocationId.make('control-invocation');
		const activeMetadata = { ...metadata, invocationId: activeInvocation };
		const controlMetadata = { ...metadata, invocationId: controlInvocation };
		const activeController = invocations.open(activeInvocation);

		yield* Effect.tryPromise(() =>
			tasks.call(activeMetadata, TaskRequest.cases.Active.make({ taskId: 'agent-turn-1' }), signal)
		);
		yield* Effect.tryPromise(() =>
			tasks.call(
				controlMetadata,
				TaskRequest.cases.Interrupt.make({ taskId: 'agent-turn-1' }),
				signal
			)
		);
		assert.strictEqual(activeController.signal.aborted, true);
		invocations.close(activeInvocation, activeController);

		const settledController = invocations.open(activeInvocation);
		yield* Effect.tryPromise(() =>
			tasks.call(activeMetadata, TaskRequest.cases.Active.make({ taskId: 'agent-turn-2' }), signal)
		);
		yield* Effect.tryPromise(() =>
			tasks.call(activeMetadata, TaskRequest.cases.Settled.make({ taskId: 'agent-turn-2' }), signal)
		);
		yield* Effect.tryPromise(() =>
			tasks.call(
				controlMetadata,
				TaskRequest.cases.Interrupt.make({ taskId: 'agent-turn-2' }),
				signal
			)
		);
		assert.strictEqual(settledController.signal.aborted, false);
		invocations.close(activeInvocation, settledController);
	})
);

it.effect('constructs each extension provider selected by Effect Config', () =>
	Effect.gen(function* () {
		let selectedEndpoint: string | undefined;
		const ai = yield* makeAiBindingFromConfig({
			fixture: {
				make: (settings) => {
					selectedEndpoint = settings.endpoint;
					return Effect.succeed({ call: async () => ({ output: {} }) });
				}
			}
		});
		const communication = yield* makeCommunicationBindingFromConfig({
			fixture: { make: () => Effect.succeed({ call: async () => ({}) }) }
		});
		const connector = yield* makeConnectorBindingFromConfig({
			fixture: { make: () => Effect.succeed({ call: async () => ({ output: {} }) }) }
		});
		// The task facility has no provider left to configure — the host owns the timer itself.
		const tasks = makeTaskBinding(
			makeTimekeeper({
				tick: () => Effect.succeed(null),
				run: Effect.runPromise,
				onFailure: () => {}
			})
		);
		const hostTools = yield* makeHostToolBindingFromConfig({
			fixture: { make: () => Effect.succeed({ call: async () => ({ output: {} }) }) }
		});
		assert.strictEqual(selectedEndpoint, 'https://ai.invalid');
		assert.deepStrictEqual(
			[ai, communication, connector, tasks, hostTools].map((binding) => typeof binding.call),
			['function', 'function', 'function', 'function', 'function']
		);
	}).pipe(
		Effect.provide(
			withConfiguration({
				BOLT_SERVER_AI_PROVIDER: 'fixture',
				BOLT_SERVER_AI_ENDPOINT: 'https://ai.invalid',
				BOLT_SERVER_AI_CREDENTIAL: 'secret-not-exposed',
				BOLT_SERVER_COMMUNICATION_PROVIDER: 'fixture',
				BOLT_SERVER_CONNECTOR_PROVIDER: 'fixture',
				BOLT_SERVER_HOST_TOOLS_PROVIDER: 'fixture'
			})
		)
	)
);
