import { assert, it } from '@effect/vitest';
import {
	AIRequest,
	ConfigRequest,
	EffectId,
	EnvironmentName,
	FileRequest,
	InvocationId,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { startLocalApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import { startLocalDatabase } from '../src/facilities/database.js';
import { startLocalFiles } from '../src/facilities/files.js';
import {
	makeAiBinding,
	makeAiProviderRouter,
	makeConfigBinding
} from '../src/facilities/providers.js';

const metadata = {
	invocationId: InvocationId.make('invocation-1'),
	effectId: EffectId.make('effect-1'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	idempotencyKey: 'local-adapters-1'
};

const signal = new AbortController().signal;
const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 30_000;
const fixturePath = fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url));

const namedProvider = (name: string) => ({
	call: async () => ({ servedBy: name })
});

const generateRequest = (modelId: string, callId: string) =>
	Schema.decodeUnknownSync(AIRequest)({
		_tag: 'Generate',
		callId,
		modelId,
		messages: [],
		maxOutputTokens: 32,
		output: { _tag: 'Message' }
	});

it.effect(
	'starts an ephemeral PGlite with extensions and a query helper',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => startLocalDatabase()),
			(database) =>
				Effect.gen(function* () {
					const rows = yield* Effect.tryPromise(() =>
						database.query(
							`select extname from pg_extension where extname in ('btree_gist', 'pg_trgm', 'vector') order by extname`
						)
					);
					assert.deepStrictEqual(rows, [
						{ extname: 'btree_gist' },
						{ extname: 'pg_trgm' },
						{ extname: 'vector' }
					]);
				}),
			(database) => Effect.promise(() => database.close())
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);

it.effect('roots ephemeral files and removes them on close', () =>
	Effect.gen(function* () {
		const files = yield* Effect.tryPromise(() => startLocalFiles());
		try {
			const written = yield* Effect.tryPromise(() =>
				files.binding.call(
					metadata,
					FileRequest.cases.Write.make({
						key: 'note.txt',
						bytes: new TextEncoder().encode('hello')
					}),
					signal
				)
			);
			assert.strictEqual(written._tag, 'Success');
		} finally {
			yield* Effect.promise(() => files.close());
		}
	})
);

it.effect('config binding answers only the keys the host supplied', () =>
	Effect.gen(function* () {
		const config = makeConfigBinding({ BOLT_SECRETS_KEY: 'secret' });
		const known = yield* Effect.tryPromise(() =>
			config.call(metadata, ConfigRequest.make({ key: 'BOLT_SECRETS_KEY' }), signal)
		);
		const unknown = yield* Effect.tryPromise(() =>
			config.call(metadata, ConfigRequest.make({ key: 'MISSING' }), signal)
		);
		assert.strictEqual(known._tag, 'Success');
		if (known._tag === 'Success') assert.strictEqual(known.value.value, 'secret');
		assert.strictEqual(unknown._tag, 'Success');
		if (unknown._tag === 'Success') assert.strictEqual(unknown.value.value, undefined);
	})
);

it.effect('AI router accepts any registered provider name and does not require OpenRouter', () =>
	Effect.gen(function* () {
		const router = makeAiProviderRouter({
			providers: {
				ollama: namedProvider('ollama'),
				anthropic: namedProvider('anthropic')
			},
			aliases: { local: 'ollama', claude: 'anthropic' },
			defaultProvider: 'ollama'
		});
		const catalog = yield* Effect.tryPromise(() =>
			router.call(metadata, AIRequest.cases.Catalog.make({}), signal)
		);
		assert.deepStrictEqual(catalog, { servedBy: 'ollama' });
		const generated = yield* Effect.tryPromise(() =>
			router.call(metadata, generateRequest('claude/opus', 'call-1'), signal)
		);
		assert.deepStrictEqual(generated, { servedBy: 'anthropic' });
		const unprefixed = yield* Effect.tryPromise(() =>
			router.call(metadata, generateRequest('plain-model', 'call-2'), signal)
		);
		assert.deepStrictEqual(unprefixed, { servedBy: 'ollama' });
	})
);

it.effect(
	'startLocalApplication listens with caller-formed facilities, including a non-OpenRouter AI',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(async () => {
				const database = await startLocalDatabase();
				try {
					const application = await startLocalApplication({
						configuration: ServerConfiguration.make({
							host: '127.0.0.1',
							port: 0,
							bundlePath: fixturePath,
							scope: {
								tenantId: TenantId.make('local-adapters'),
								environment: EnvironmentName.make('test'),
								releaseId: ReleaseId.make('local-adapters')
							},
							mode: 'development',
							drainTimeoutMillis: 1_000,
							invocationTimeoutMillis: 1_000,
							requestBodyLimitBytes: 1024
						}),
						facilities: {
							scope: {
								tenantId: TenantId.make('local-adapters'),
								environment: EnvironmentName.make('test'),
								releaseId: ReleaseId.make('local-adapters')
							},
							database: database.binding,
							ai: makeAiBinding({
								call: async () => ({
									_tag: 'Catalog',
									languageModels: [{ id: 'ollama/llama' }],
									defaultLanguageModelId: 'ollama/llama',
									embeddingModels: [{ id: 'ollama/nomic' }],
									defaultEmbeddingModelId: 'ollama/nomic'
								})
							}),
							config: makeConfigBinding({ BOLT_SECRETS_KEY: 'local-adapters' })
						}
					});
					return { application, database };
				} catch (error) {
					await database.close();
					throw error;
				}
			}),
			({ application }) =>
				Effect.gen(function* () {
					assert.match(application.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
					const ready = yield* Effect.tryPromise(() => fetch(`${application.baseUrl}/readyz`));
					assert.strictEqual(ready.status, 200);
				}),
			({ application, database }) =>
				Effect.promise(async () => {
					await application.stop();
					await database.close();
				})
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);
