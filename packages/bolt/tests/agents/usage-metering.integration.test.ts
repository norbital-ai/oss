import { afterEach, describe, expect, it } from 'vitest';
import {
	PROTOCOL_VERSION,
	type AIRequest,
	type AIResponse,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityBindings,
	type FacilityResult,
	type Invocation,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { EnvironmentName, InvocationId, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	modelMessages
} from './canonical-ai-fixture.js';

const scope = {
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};
const modelCatalogResponse = () =>
	Promise.resolve<FacilityResult<AIResponse>>({
		_tag: 'Success',
		value: {
			output: {
				defaultModel: 'test-model',
				options: [{ id: 'test-model', contextLength: 128_000 }]
			}
		}
	});

const definition = workspace({
	name: 'hr',
	version: '1.0.0',
	collections: [
		collection({ name: 'employees', fields: { name: field.string({ required: true }) } })
	],
	apps: [app({ name: 'hr', label: 'HR' })],
	policies: [
		policy({
			name: 'admin-agent',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['web'] }
		})
	],
	teams: {
		'admin-agent': ['admin-agent'],
		admin: ['admin-agent']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database', 'ai', 'tasks'],
	schemaFingerprint: 'sha256:usage-metering-fixture'
});
const manifest = buildManifest(definition, { artifactId: 'hr-usage' });
const bundle = makeBundle(definition, manifest, {});

/**
 * A workspace remote that infers twice, which is the shape that used to collide.
 *
 * `api.infer` is handed the invocation's effect id verbatim, so two calls inside one handler — or a
 * before-hook and an after-hook on the same write — asked the host to run two model calls under one
 * id. The host uses that id as the provider idempotency key and as the identity of the usage
 * observation, so the second call was answered with the first one's completion and billed to a row
 * that already existed. Nobody paid for it, and nobody could tell from the answer.
 */
const twiceInferringBundle = makeBundle(definition, manifest, {
	classify: (_input: unknown, api) =>
		Effect.gen(function* () {
			// Run the calls sequentially: the point of the test is two distinct invocations, not two
			// started at once.
			const first = yield* api.infer({ schema: Schema.String, prompt: 'first' });
			const second = yield* api.infer({ schema: Schema.String, prompt: 'second' });
			return { first, second };
		})
});
const groundedInferringBundle = makeBundle(definition, manifest, {
	classify: (_input: unknown, api) =>
		api.infer({
			schema: Schema.Struct({ changed: Schema.Boolean, sources: Schema.Array(Schema.String) }),
			prompt: 'Check the current statutory profile.',
			model: 'openai/gpt-5.2',
			webSearch: { maxResults: 4, allowedDomains: ['acra.gov.sg', 'iras.gov.sg'] }
		})
});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', teamPath: ['admin'], policies: [] };

let agentHarness: BoltTestRuntime | undefined;
afterEach(async () => {
	await agentHarness?.dispose();
	agentHarness = undefined;
});

const runCanonicalAgent = async (
	ai: FacilityBinding<AIRequest, AIResponse>,
	conversationId: string,
	message: string
) => {
	agentHarness = await makeBoltTestRuntime(definition, { ai });
	const agents = await agentHarness.runtime.runPromise(Agents.Service);
	return agentHarness.runtime.runPromise(
		agents.enqueue(
			agentHarness.effectId(`enqueue:${conversationId}`),
			adminSubject,
			'web',
			conversationId,
			`input:${conversationId}`,
			Agents.userAgentInput(message)
		)
	);
};

type Statement = { readonly sql: string; readonly parameters: ReadonlyArray<unknown> };

const operationOn = (statement: Statement, operation: 'insert' | 'update', table: string) =>
	new RegExp(
		`^${operation === 'insert' ? 'insert\\s+into' : 'update'}\\s+"?${table}"?\\b`,
		'i'
	).test(statement.sql.trim());

const selectsFrom = (sql: string, table: string) =>
	new RegExp(`\\bfrom\\s+"?${table}"?\\b`, 'i').test(sql);

const jsonObjectParameter = (statement: Statement) => {
	for (const parameter of statement.parameters) {
		if (typeof parameter !== 'string') continue;
		try {
			const parsed: unknown = JSON.parse(parameter);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
				return parsed as Record<string, unknown>;
		} catch {
			// Drizzle also binds ordinary string columns; only JSON objects are interesting here.
		}
	}
	return undefined;
};

const parameterAssignedTo = (statement: Statement, column: string) => {
	const placeholder = new RegExp(
		`"?${column}"?\\s*=\\s*(?:"?chat_session"?\\."?${column}"?\\s*\\+\\s*)?\\$(\\d+)`,
		'i'
	).exec(statement.sql)?.[1];
	return placeholder === undefined ? undefined : statement.parameters[Number(placeholder) - 1];
};

/**
 * A database that answers authentication and records what the loop wrote.
 *
 * The writes are the assertion surface on purpose: what a reader is shown and what the host bills
 * are both projections of these rows, so a fixture of what they are believed to contain would prove
 * nothing about either.
 */
const makeDatabase = (
	statements: Array<Statement>
): FacilityBinding<DatabaseRequest, DatabaseResponse> => ({
	call: (() => {
		let message = 0;
		const claimed = new Set<string>();
		return (_metadata, request) => {
			if (request._tag === 'Transaction') {
				statements.push(...request.statements);
				return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
			}

			const statement = { sql: request.sql, parameters: request.parameters };
			statements.push(statement);
			if (request.sql.includes('pg_advisory_xact_lock')) {
				const conversationId = String(request.parameters[0] ?? '');
				if (claimed.has(conversationId)) {
					return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } });
				}
				claimed.add(conversationId);
				const turnId = `agent-usage-${conversationId}:turn`;
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [
							{
								task_id: turnId,
								conversation_id: conversationId
							}
						],
						affectedRows: 1
					}
				});
			}
			if (request.sql.includes('as mailbox_status') && request.sql.includes('as has_running')) {
				return Promise.resolve({
					_tag: 'Success',
					value: { rows: [{ mailbox_status: 'active', has_running: false }], affectedRows: 0 }
				});
			}
			if (selectsFrom(request.sql, 'auth_config')) {
				return Promise.resolve({
					_tag: 'Success',
					value: { rows: [{ value: 'test-session-secret-for-usage-metering' }], affectedRows: 0 }
				});
			}
			if (selectsFrom(request.sql, 'session')) {
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [
							{
								id: subject.userId,
								tenantId: subject.tenantId,
								email: null,
								status: 'normal',
								team_id: 'team-admin'
							}
						],
						affectedRows: 0
					}
				});
			}
			if (selectsFrom(request.sql, 'team')) {
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [
							{
								id: 'team-admin',
								name: subject.teamPath[0],
								parent_id: null,
								description: null
							}
						],
						affectedRows: 0
					}
				});
			}
			if (selectsFrom(request.sql, 'chat_session')) {
				const conversationId = String(request.parameters[0] ?? '');
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [
							{
								conversation_id: conversationId,
								agent_name: 'web',
								title: null,
								user_id: subject.userId,
								sandbox_key: subject.userId,
								visibility: 'personal',
								envoy_key: null,
								parent_id: conversationId.startsWith('agent:') ? 'conversation-parent' : null
							}
						],
						affectedRows: 0
					}
				});
			}
			if (
				selectsFrom(request.sql, 'chat_session') &&
				request.sql.includes('"conversation_id"') &&
				request.sql.includes('"parent_id"')
			) {
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [{ conversation_id: String(request.parameters[0] ?? ''), parent_id: null }],
						affectedRows: 0
					}
				});
			}
			if (operationOn(statement, 'insert', 'chat_message')) {
				message += 1;
				return Promise.resolve({
					_tag: 'Success',
					value: { rows: [{ id: `message-${message}` }], affectedRows: 1 }
				});
			}
			return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
		};
	})()
});

const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: () => Promise.resolve({ _tag: 'Success', value: {} })
};

const turnInvocation = (conversationId: string, message: string): Invocation => ({
	_tag: 'Command',
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make(`agent-usage-${conversationId}`),
	scope,
	deadlineEpochMs: Date.now() + 10_000,
	command: 'agents.enqueue',
	input: {
		agent: 'web',
		conversationId,
		turnId: `agent-usage-${conversationId}:turn`,
		message
	},
	headers: { authorization: ['Bearer test-session'] }
});

/** The rewritten turn rows, newest last — the loop rewrites one row as each step lands. */
const turnRewrites = (statements: ReadonlyArray<Statement>) =>
	statements
		.filter((entry) => operationOn(entry, 'update', 'chat_message'))
		.map(jsonObjectParameter)
		.filter((entry): entry is Record<string, unknown> => entry !== undefined);

const usageWrite = (statements: ReadonlyArray<Statement>) =>
	statements.find(
		(entry) =>
			operationOn(entry, 'update', 'chat_session') && entry.sql.includes('usage_total_tokens')
	);

describe('agent turn usage', () => {
	it('folds every round of a turn into one figure and rolls it onto the session', async () => {
		let round = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				round += 1;
				const value: AIResponse =
					round === 1
						? {
								output: assistantToolCall('describe_workspace', {}, 'usage-describe'),
								usage: {
									inputTokens: 1_000,
									outputTokens: 200,
									totalTokens: 1_200,
									costUsd: 0.003,
									costMicroUnits: 7_800,
									costCurrency: 'SGD'
								}
							}
						: {
								output: assistantText('Two collections.', 'usage-answer'),
								usage: {
									inputTokens: 1_400,
									outputTokens: 100,
									totalTokens: 1_500,
									costUsd: 0.004,
									costMicroUnits: 10_400,
									costCurrency: 'SGD'
								}
							};
				return Promise.resolve<FacilityResult<AIResponse>>({ _tag: 'Success', value });
			}
		};
		const result = await runCanonicalAgent(
			ai,
			'conversation-usage',
			'What collections exist?'
		);
		expect(result.status).toBe('completed');
		expect(round).toBe(2);

		expect(
			await agentHarness!.database.query(
				`select status, usage, usage_unreported from agent_run where conversation_id = $1`,
				['conversation-usage']
			)
		).toEqual([
			{
				status: 'completed',
				usage: {
					inputTokens: 2_400,
					outputTokens: 300,
					totalTokens: 2_700,
					costUsd: 0.007,
					costMicroUnits: 18_200,
					costCurrency: 'SGD'
				},
				usage_unreported: false
			}
		]);
		expect(
			await agentHarness!.database.query(
				`select usage_cost_usd, usage_cost_micro_units, usage_cost_currency,
				 usage_total_tokens, usage_turns_counted, usage_turns_unreported
				 from chat_session where conversation_id = $1`,
				['conversation-usage']
			)
		).toEqual([
			{
				usage_cost_usd: 0.007,
				usage_cost_micro_units: 18_200,
				usage_cost_currency: 'SGD',
				usage_total_tokens: 2_700,
				usage_turns_counted: 1,
				usage_turns_unreported: 0
			}
		]);
	});

	it('counts a turn its host priced at nothing as unreported, not as free', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) =>
				request._tag === 'Models'
					? modelCatalogResponse()
					: Promise.resolve<FacilityResult<AIResponse>>({
							_tag: 'Success',
							value: { output: assistantText('Hello.', 'unpriced-answer') }
						})
		};
		await runCanonicalAgent(ai, 'conversation-unpriced', 'Hi');
		expect(
			await agentHarness!.database.query(
				`select usage, usage_unreported from agent_run where conversation_id = $1`,
				['conversation-unpriced']
			)
		).toEqual([{ usage: null, usage_unreported: true }]);
		expect(
			await agentHarness!.database.query(
				`select usage_cost_usd, usage_cost_micro_units, usage_cost_currency,
				 usage_total_tokens, usage_turns_counted, usage_turns_unreported
				 from chat_session where conversation_id = $1`,
				['conversation-unpriced']
			)
		).toEqual([
			{
				usage_cost_usd: 0,
				usage_cost_micro_units: 0,
				usage_cost_currency: null,
				usage_total_tokens: 0,
				usage_turns_counted: 1,
				usage_turns_unreported: 1
			}
		]);
	});

	it('preserves a child agent parent link so its spend can be traced through the hierarchy', async () => {
		let parentRound = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				if (request._tag !== 'Turn') throw new Error('expected a turn');
				const messages = modelMessages(request);
				const child = messages.some(
					(message) =>
						message.role === 'user' && String(message.content).includes('Summarise the headcount')
				);
				let output;
				if (child) output = assistantText('Child done.', 'child-usage-answer');
				else if (parentRound === 0) {
					parentRound += 1;
					output = assistantToolCall(
						'spawn_agent',
						{ task: 'Summarise the headcount' },
						'spawn-usage'
					);
				} else if (parentRound === 1) {
					parentRound += 1;
					const spawned = lastToolResult(request);
					output = assistantToolCall(
						'await_agent',
						{ agentId: String(spawned?.agentId), taskId: String(spawned?.taskId) },
						'await-usage'
					);
				} else output = assistantText('Parent done.', 'parent-usage-answer');
				return Promise.resolve({
					_tag: 'Success' as const,
					value: { output, usage: { totalTokens: 40, costUsd: 0.0001 } }
				});
			}
		};
		await runCanonicalAgent(ai, 'conversation-parent-usage', 'Delegate the work.');
		expect(
			await agentHarness!.database.query(
				`select parent_id, usage_cost_usd, usage_total_tokens, usage_turns_counted
				 from chat_session where parent_id = $1`,
				['conversation-parent-usage']
			)
		).toEqual([
			{
				parent_id: 'conversation-parent-usage',
				usage_cost_usd: 0.0001,
				usage_total_tokens: 40,
				usage_turns_counted: 1
			}
		]);
		expect(
			await agentHarness!.database.query(
				`select usage_cost_usd, usage_total_tokens, usage_turns_counted
				 from chat_session where conversation_id = $1`,
				['conversation-parent-usage']
			)
		).toEqual([
			{
				usage_cost_usd: 0.0004,
				usage_total_tokens: 160,
				usage_turns_counted: 2
			}
		]);
	});

	it('meters a second api.infer in one invocation instead of replaying the first', async () => {
		const seen: Array<{
			readonly effectId: string;
			readonly idempotencyKey: string;
			readonly prompt: string;
		}> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request) => {
				const prompt =
					request._tag === 'Turn' ? JSON.stringify(request.messages[0] ?? null) : 'models';
				seen.push({
					effectId: String(metadata.effectId),
					idempotencyKey: String(metadata.idempotencyKey),
					prompt
				});
				return Promise.resolve<FacilityResult<AIResponse>>({
					_tag: 'Success',
					value: { output: `answer-${seen.length}`, usage: { totalTokens: 12, costUsd: 0.0002 } }
				});
			}
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		const result = await twiceInferringBundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('remote-infer-twice'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'invoke.classify',
				input: { input: {}, subject },
				headers: { authorization: ['Bearer test-session'] }
			},
			facilities,
			new AbortController().signal
		);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { first: 'answer-1', second: 'answer-2' } }
		});
		expect(seen).toHaveLength(2);
		// Two prompts, two charges, two meter identities. These were one id, so the host's ledger held a
		// single observation for two turns and the provider answered the second from its idempotency
		// cache — the second inference was neither run nor paid for.
		expect(seen[0]?.prompt).not.toBe(seen[1]?.prompt);
		expect(seen[0]?.effectId).not.toBe(seen[1]?.effectId);
		expect(seen[0]?.idempotencyKey).not.toBe(seen[1]?.idempotencyKey);
	});

	it('carries authored web search and the output JSON schema on a structured inference turn', async () => {
		const captured: Array<AIRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				captured.push(request);
				return Promise.resolve({
					_tag: 'Success',
					value: {
						output:
							captured.length === 1
								? { text: 'Grounded official-source research.' }
								: { changed: false, sources: ['https://www.acra.gov.sg/'] },
						usage: { totalTokens: 32, costUsd: 0.0004 }
					}
				});
			}
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		const result = await groundedInferringBundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('remote-grounded-infer'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'invoke.classify',
				input: { input: {}, subject },
				headers: { authorization: ['Bearer test-session'] }
			},
			facilities,
			new AbortController().signal
		);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: {
				value: { changed: false, sources: ['https://www.acra.gov.sg/'] }
			}
		});
		expect(captured).toHaveLength(2);
		expect(captured[0]).toMatchObject({
			_tag: 'Turn',
			model: 'openai/gpt-5.2',
			maxOutputTokens: 8_192,
			webSearch: { maxResults: 4, allowedDomains: ['acra.gov.sg', 'iras.gov.sg'] }
		});
		expect(captured[0]).not.toHaveProperty('responseSchema');
		expect(captured[1]).toMatchObject({
			_tag: 'Turn',
			model: 'openai/gpt-5.2',
			maxOutputTokens: 8_192,
			responseSchema: {
				type: 'object',
				properties: {
					changed: { type: 'boolean' },
					sources: { type: 'array', items: { type: 'string' } }
				},
				required: ['changed', 'sources'],
				additionalProperties: false
			}
		});
		expect(captured[1]).not.toHaveProperty('webSearch');
		if (captured[1]?._tag !== 'Turn')
			throw new Error('Structured inference did not issue an AI turn');
		expect(captured[1].messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					content: 'Grounded official-source research.'
				})
			])
		);
		expect(captured[1].responseSchema).toEqual(
			Schema.toJsonSchemaDocument(
				Schema.Struct({ changed: Schema.Boolean, sources: Schema.Array(Schema.String) })
			).schema
		);
	});

	it('rejects provider JSON that does not satisfy the authored inference schema', async () => {
		let calls = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				calls += 1;
				return Promise.resolve({
					_tag: 'Success',
					value: {
						output:
							calls === 1
								? { text: 'Grounded official-source research.' }
								: { changed: 'yes', sources: [] },
						usage: { totalTokens: 32, costUsd: 0.0004 }
					}
				});
			}
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		await expect(
			groundedInferringBundle.dispatch(
				{
					_tag: 'Command',
					protocolVersion: PROTOCOL_VERSION,
					id: InvocationId.make('remote-grounded-infer-invalid-schema'),
					scope,
					deadlineEpochMs: Date.now() + 10_000,
					command: 'invoke.classify',
					input: { input: {}, subject },
					headers: { authorization: ['Bearer test-session'] }
				},
				facilities,
				new AbortController().signal
			)
		).rejects.toThrow('Expected boolean');
	});

	it('gives every model call in one invocation a distinct meter identity', async () => {
		// The effect id is the provider idempotency key *and* the id of the usage observation the host
		// writes. Two calls sharing one is the second being answered with the first one's completion and
		// billed to a row that already exists — so the loop's rounds must never collide.
		const effectIds: Array<string> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				effectIds.push(String(metadata.effectId));
				const value: AIResponse =
					effectIds.length === 1
						? { output: assistantToolCall('describe_workspace', {}, 'meter-id-call') }
						: { output: assistantText('Done.', 'meter-id-answer') };
				return Promise.resolve<FacilityResult<AIResponse>>({ _tag: 'Success', value });
			}
		};
		await runCanonicalAgent(ai, 'conversation-ids', 'What collections exist?');
		expect(effectIds.length).toBe(2);
		expect(new Set(effectIds).size).toBe(effectIds.length);
		// And the idempotency key the host retries under is that same distinct id.
		expect(effectIds.every((id) => id.length > 0)).toBe(true);
	});
});
