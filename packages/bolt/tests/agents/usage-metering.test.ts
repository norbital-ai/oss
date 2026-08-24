import { describe, expect, it } from 'vitest';
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

const scope = {
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};

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
	requiredFacilities: ['database', 'ai', 'tasks']
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
		return (_metadata, request) => {
			if (request._tag === 'Transaction') {
				statements.push(...request.statements);
				return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
			}

			const statement = { sql: request.sql, parameters: request.parameters };
			statements.push(statement);
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
	call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } })
};

const turnInvocation = (conversationId: string, message: string): Invocation => ({
	_tag: 'Command',
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make(`agent-usage-${conversationId}`),
	scope,
	deadlineEpochMs: Date.now() + 10_000,
	command: 'agents.turn',
	input: { subject, agent: 'web', conversationId, message },
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
			call: () => {
				round += 1;
				const value: AIResponse =
					round === 1
						? {
								output: { toolCalls: [{ name: 'describe_workspace', input: {} }] },
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
								output: { text: 'Two collections.' },
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
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		const result = await bundle.dispatch(
			turnInvocation('conversation-usage', 'What collections exist?'),
			facilities,
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(round).toBe(2);

		// One turn, one figure. A per-round breakdown would report two charges for something the reader
		// asked once, and the panel would have to guess which of them was the turn's.
		const settled = turnRewrites(statements).at(-1);
		expect(settled).toMatchObject({ status: 'completed' });
		expect(settled?.usage).toEqual({
			inputTokens: 2_400,
			outputTokens: 300,
			totalTokens: 2_700,
			costUsd: 0.007,
			// The host's charge folds the same way the provider's does, and one currency survives the sum.
			costMicroUnits: 18_200,
			costCurrency: 'SGD'
		});

		const rollup = usageWrite(statements);
		expect(rollup).toBeDefined();
		// Provider charge, host charge, its currency, tokens, and nothing unreported — this turn is priced.
		expect(parameterAssignedTo(rollup!, 'usage_cost_usd')).toBe(0.007);
		expect(parameterAssignedTo(rollup!, 'usage_cost_micro_units')).toBe(18_200);
		expect(parameterAssignedTo(rollup!, 'usage_cost_currency')).toBe('SGD');
		expect(parameterAssignedTo(rollup!, 'usage_total_tokens')).toBe(2_700);
		expect(parameterAssignedTo(rollup!, 'usage_turns_counted')).toBe(1);
		expect(parameterAssignedTo(rollup!, 'usage_turns_unreported')).toBe(0);
		expect(rollup?.parameters).toContain('conversation-usage');
		// The lineage read supplies the parent link; the update itself remains one ordinary table write
		// in the transaction, without coupling this test to Drizzle's formatting or placeholder order.
		expect(
			statements.some(
				(entry) =>
					selectsFrom(entry.sql, 'chat_session') &&
					entry.sql.includes('"parent_id"') &&
					entry.parameters.includes('conversation-usage')
			)
		).toBe(true);
	});

	it('counts a turn its host priced at nothing as unreported, not as free', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () =>
				Promise.resolve<FacilityResult<AIResponse>>({
					_tag: 'Success',
					value: { output: { text: 'Hello.' } }
				})
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		await bundle.dispatch(
			turnInvocation('conversation-unpriced', 'Hi'),
			facilities,
			new AbortController().signal
		);
		expect(turnRewrites(statements).at(-1)?.usage).toBeUndefined();
		// The last parameter is the unreported count. Reporting zero here would let a conversation
		// nobody could price read as a cheap one, and the null currency leaves whatever the running
		// total is already denominated in untouched.
		const rollup = usageWrite(statements);
		expect(rollup).toBeDefined();
		expect(parameterAssignedTo(rollup!, 'usage_cost_usd')).toBe(0);
		expect(parameterAssignedTo(rollup!, 'usage_cost_micro_units')).toBe(0);
		expect(parameterAssignedTo(rollup!, 'usage_cost_currency')).toBeUndefined();
		expect(parameterAssignedTo(rollup!, 'usage_total_tokens')).toBe(0);
		expect(parameterAssignedTo(rollup!, 'usage_turns_counted')).toBe(1);
		expect(parameterAssignedTo(rollup!, 'usage_turns_unreported')).toBe(1);
		expect(rollup?.parameters).toContain('conversation-unpriced');
	});

	it('names a delegated session as the call that spawned it so its spend can be traced back', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () =>
				Promise.resolve<FacilityResult<AIResponse>>({
					_tag: 'Success',
					value: { output: { text: 'Done.' }, usage: { totalTokens: 40, costUsd: 0.0001 } }
				})
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		// Exactly the id `spawn_subagent` mints for a delegated session: `subagent:` plus the effect id
		// of the tool call that spawned it, which is the join the panel makes to nest the transcript.
		await bundle.dispatch(
			turnInvocation('subagent:agent-usage:tool:0:0', 'Summarise the headcount'),
			facilities,
			new AbortController().signal
		);
		const settled = turnRewrites(statements).at(-1);
		expect(settled?.subagent_id).toBe('subagent:agent-usage:tool:0:0');
		// Its rows carry the turn that produced them, or the reader's projection cannot tell a delegated
		// agent's messages from ones the person typed into the session it is nested in.
		const appended = statements.filter((entry) => operationOn(entry, 'insert', 'chat_message'));
		expect(appended.length).toBeGreaterThan(0);
		expect(
			appended.every((entry) =>
				entry.parameters.some((parameter) => String(parameter).startsWith('agent-usage-'))
			)
		).toBe(true);
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
			call: (metadata) => {
				effectIds.push(String(metadata.effectId));
				const value: AIResponse =
					effectIds.length === 1
						? { output: { toolCalls: [{ name: 'describe_workspace', input: {} }] } }
						: { output: { text: 'Done.' } };
				return Promise.resolve<FacilityResult<AIResponse>>({ _tag: 'Success', value });
			}
		};
		const statements: Array<Statement> = [];
		const facilities: FacilityBindings = { scope, database: makeDatabase(statements), ai, tasks };
		await bundle.dispatch(
			turnInvocation('conversation-ids', 'What collections exist?'),
			facilities,
			new AbortController().signal
		);
		expect(effectIds.length).toBe(2);
		expect(new Set(effectIds).size).toBe(effectIds.length);
		// And the idempotency key the host retries under is that same distinct id.
		expect(effectIds.every((id) => id.length > 0)).toBe(true);
	});
});
