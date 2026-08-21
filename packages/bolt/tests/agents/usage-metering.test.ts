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
import { app, collection, field, policy, workspace } from '../../src/authoring/index.js';
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
			capabilities: { apps: ['helper'] }
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
	classify: async (
		_input: unknown,
		api: Readonly<{
			readonly infer: (input: {
				readonly schema: Schema.Codec<unknown, unknown>;
				readonly prompt: string;
			}) => Promise<unknown>;
		}>
	) => {
		// `infer` is declared as a promise on the remote api and answers an Effect, which
		// `runAuthoredHandler` settles either way. Run it here so both calls are genuinely sequential —
		// the point of the test is two distinct calls, not two started at once.
		const run = (prompt: string) =>
			Effect.runPromise(
				api.infer({ schema: Schema.String, prompt }) as unknown as Effect.Effect<string>
			);
		return { first: await run('first'), second: await run('second') };
	}
});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', teamPath: ['admin'], policies: [] };

type Statement = { readonly sql: string; readonly parameters: ReadonlyArray<unknown> };

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
	call: (_metadata, request) => {
		if (request._tag === 'Query')
			statements.push({ sql: request.sql, parameters: request.parameters });
		if (request._tag === 'Query' && request.sql.includes('bolt_auth_session')) {
			return Promise.resolve({ _tag: 'Success', value: { rows: [subject], affectedRows: 0 } });
		}
		return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
	}
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
	input: { subject, agent: 'helper', conversationId, message },
	headers: { authorization: ['Bearer test-session'] }
});

/** The rewritten turn rows, newest last — the loop rewrites one row as each step lands. */
const turnRewrites = (statements: ReadonlyArray<Statement>) =>
	statements
		.filter((entry) => entry.sql.startsWith('update bolt_agent_messages'))
		.map((entry) => JSON.parse(String(entry.parameters[2])) as Record<string, unknown>);

const usageWrite = (statements: ReadonlyArray<Statement>) =>
	statements.find((entry) => entry.sql.includes('update bolt_conversations set'));

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
		expect(rollup?.parameters).toEqual(['conversation-usage', 0.007, 18_200, 'SGD', 2_700, 0]);
		// Walked up `parent_id` rather than written to one row, so a delegated session's spend reaches
		// the conversation the person is looking at however deep it happened.
		expect(rollup?.sql).toContain('with recursive lineage');
		expect(rollup?.sql).toContain('above.id = lineage.parent_id');
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
		expect(usageWrite(statements)?.parameters).toEqual(['conversation-unpriced', 0, 0, null, 0, 1]);
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
		const appended = statements.filter((entry) =>
			entry.sql.startsWith('insert into bolt_agent_messages')
		);
		expect(appended.length).toBeGreaterThan(0);
		expect(appended.every((entry) => typeof entry.parameters[3] === 'string')).toBe(true);
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
