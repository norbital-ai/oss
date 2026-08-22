import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type AIRequest,
	type AIResponse,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityBindings,
	type Invocation as InvocationType,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';

const scope = {
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};

const definition = workspace({
	name: 'resume-test',
	version: '0.0.1',
	collections: [
		collection({ name: 'employees', fields: { name: field.string({ required: true }) } })
	],
	apps: [app({ name: 'people', label: 'People' })],
	policies: [
		policy({
			name: 'agent',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['web'] }
		})
	],
	teams: { agent: ['agent'], admin: ['agent'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'Coordinate the delegated work.',
	tools: [],
	skills: [],
	requiredFacilities: ['database', 'ai', 'tasks']
});

const bundle = makeBundle(definition, buildManifest(definition, { artifactId: 'resume-test' }), {});
const subject = {
	userId: 'admin-1',
	tenantId: 'tenant-1',
	teamPath: ['admin'],
	policies: []
};
const parentId = 'conversation-parent';
const childId = 'subagent:parent-turn:tool:0:0';
const turnId = 'parent-turn';
const awaitCallId = `${turnId}:tool:1:0`;

type JsonObject = Readonly<{ readonly [key: string]: Schema.Json }>;
type Statement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;

const parkedTurn = (resumed = 0): JsonObject => ({
	id: turnId,
	status: 'running',
	subagent_id: null,
	parts: [
		{
			kind: 'tool',
			id: awaitCallId,
			name: 'await_sandbox_agent',
			input: { sessionId: childId }
		},
		{
			kind: 'tool-result',
			id: awaitCallId,
			name: 'await_sandbox_agent',
			output: { waiting: true, targetSessionId: childId }
		}
	],
	resumed,
	subject,
	agent_name: 'web',
	usage: { totalTokens: 10, costUsd: 0.1 },
	usage_unreported: false
});

const targetTurn: JsonObject = {
	id: 'child-turn',
	status: 'completed',
	parts: [{ kind: 'text', text: 'The draft is ready.' }]
};

const task = (command: string, input: Schema.Json): InvocationType =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`task-${command}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input,
		attempt: 0
	});

const command = (name: string, input: Schema.Json): InvocationType =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input,
		headers: { authorization: ['Bearer test-session'] }
	});

const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } })
};

/** A stateful database boundary that applies exactly the resume statements the runtime emits. */
const resumeStore = (initial = parkedTurn(), authorized = true) => {
	let current = initial;
	const statements: Array<Statement> = [];
	const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
		call: (_metadata, request) => {
			const answer = (rows: ReadonlyArray<JsonObject> = []) =>
				Promise.resolve({
					_tag: 'Success' as const,
					value: { rows, affectedRows: rows.length }
				});
			if (request._tag !== 'Query') return answer();
			statements.push({ sql: request.sql, parameters: request.parameters });
			if (request.sql.includes('join chat_session parent')) {
				return answer(
					authorized
						? [
								{
									parent_id: parentId,
									target_user_id: subject.userId,
									parent_user_id: subject.userId
								}
							]
						: []
				);
			}
			if (request.sql.includes("content->>'status' in")) return answer([{ content: targetTurn }]);
			if (request.sql.startsWith('update chat_message set content = $3::jsonb')) {
				current = JSON.parse(String(request.parameters[2])) as JsonObject;
				return answer();
			}
			if (request.sql.includes("content->>'status' = 'running'")) {
				return answer(current.status === 'running' ? [{ content: current }] : []);
			}
			if (request.sql.startsWith('select role, content from chat_message')) {
				return answer([
					{ role: 'user', content: 'Please delegate the draft.' },
					{ role: 'assistant', content: current }
				]);
			}
			if (request.sql.startsWith('select parent_id from chat_session')) {
				return answer([{ parent_id: null }]);
			}
			return answer();
		}
	};
	return { database, statements, current: () => current };
};

describe('agent continuation', () => {
	it('answers the parked await and continues the same turn to completion', async () => {
		const store = resumeStore();
		let modelMessages: ReadonlyArray<Schema.Json> = [];
		let calls = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				calls += 1;
				if (request._tag === 'Turn') modelMessages = request.messages;
				return Promise.resolve({
					_tag: 'Success',
					value: {
						output: { text: 'Combined the delegated draft.' },
						usage: { totalTokens: 20, costUsd: 0.2 }
					}
				});
			}
		};
		const facilities: FacilityBindings = { scope, database: store.database, ai, tasks };
		const invocation = task('agents.resume', {
			conversationId: parentId,
			targetSessionId: childId
		});
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result, JSON.stringify(result)).toMatchObject({
			_tag: 'Success',
			response: { value: { resumed: true } }
		});
		expect(calls).toBe(1);
		expect(store.current()).toMatchObject({
			id: turnId,
			status: 'completed',
			resumed: 1,
			usage: { totalTokens: 30 }
		});
		const finalUsage = Schema.decodeUnknownSync(Schema.Struct({ costUsd: Schema.Number }))(
			store.current().usage
		);
		expect(finalUsage.costUsd).toBeCloseTo(0.3);
		const parts = store.current().parts as ReadonlyArray<JsonObject>;
		expect(parts[1]).toMatchObject({
			kind: 'tool-result',
			id: awaitCallId,
			output: { waiting: false, output: targetTurn }
		});
		expect(parts.at(-1)).toEqual({ kind: 'text', text: 'Combined the delegated draft.' });
		const toolAnswer = modelMessages.find(
			(message) =>
				typeof message === 'object' && message !== null && Reflect.get(message, 'role') === 'tool'
		);
		if (toolAnswer === undefined || toolAnswer === null || typeof toolAnswer !== 'object') {
			throw new Error('resumed prompt has no tool answer');
		}
		expect(JSON.parse(String(Reflect.get(toolAnswer, 'content')))).toEqual({
			waiting: false,
			output: targetTurn
		});
		// A continuation replays the existing user row; it does not append an empty replacement prompt.
		expect(
			store.statements.filter((entry) => entry.sql.startsWith('insert into chat_message'))
		).toEqual([]);
		const usage = store.statements.find((entry) =>
			entry.sql.includes('update chat_session set')
		);
		// Only the resumed segment is added, and it is still one logical turn (`turnsCounted = 0`).
		expect(usage?.parameters).toEqual([parentId, 0.2, 0, null, 20, 0, 0]);

		// The same settlement delivered again sees no running parent and does no more model work.
		const replay = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(replay).toMatchObject({ _tag: 'Success' });
		expect(calls).toBe(1);
	});

	it('refuses a target outside the parent conversation before reading or invoking it', async () => {
		const store = resumeStore(parkedTurn(), false);
		let calls = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				calls += 1;
				return Promise.resolve({ _tag: 'Success', value: { output: { text: 'wrong' } } });
			}
		};
		const result = await bundle.dispatch(
			task('agents.resume', { conversationId: parentId, targetSessionId: childId }),
			{ scope, database: store.database, ai, tasks },
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Failure', error: { httpStatus: 403 } });
		expect(calls).toBe(0);
		expect(store.current()).toEqual(parkedTurn());
	});

	it('fails the parked turn without a fifth continuation', async () => {
		const store = resumeStore(parkedTurn(4));
		let calls = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				calls += 1;
				return Promise.resolve({ _tag: 'Success', value: { output: { text: 'wrong' } } });
			}
		};
		const result = await bundle.dispatch(
			task('agents.resume', { conversationId: parentId, targetSessionId: childId }),
			{ scope, database: store.database, ai, tasks },
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(calls).toBe(0);
		expect(store.current()).toMatchObject({ status: 'failed', resumed: 4 });
	});

	it('enqueues the parent exactly when a delegated child settles', async () => {
		const statements: Array<Statement> = [];
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				const rows =
					request._tag === 'Query' && request.sql.includes('bolt_auth_session')
						? [subject]
						: request._tag === 'Query' &&
							  request.sql.startsWith('select parent_id from chat_session')
							? [{ parent_id: parentId }]
							: [];
				if (request._tag === 'Query') {
					statements.push({ sql: request.sql, parameters: request.parameters });
				}
				return Promise.resolve({
					_tag: 'Success',
					value: { rows, affectedRows: rows.length }
				});
			}
		};
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () =>
				Promise.resolve({
					_tag: 'Success',
					value: { output: { text: 'Child finished.' } }
				})
		};
		const result = await bundle.dispatch(
			command('agents.turn', {
				subject,
				agent: 'web',
				conversationId: childId,
				message: 'Draft it.'
			}),
			{ scope, database, ai, tasks },
			new AbortController().signal
		);
		expect(result, JSON.stringify(result)).toMatchObject({ _tag: 'Success' });
		const enqueue = statements.find((entry) => entry.sql.includes('insert into "bolt_task"'));
		expect(enqueue).toBeDefined();
		expect(enqueue?.parameters).toContain('agents.resume');
		expect(enqueue?.parameters).toContain('command-agents.turn:resume-parent');
		expect(enqueue?.parameters).toContainEqual({
			conversationId: parentId,
			targetSessionId: childId
		});
	});

	it('persists cancellation on the turn as well as cancelling queued work', async () => {
		const statements: Array<Statement> = [];
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Query') {
					statements.push({ sql: request.sql, parameters: request.parameters });
				}
				const rows =
					request._tag === 'Query' && request.sql.includes('bolt_auth_session') ? [subject] : [];
				return Promise.resolve({
					_tag: 'Success',
					value: { rows, affectedRows: rows.length }
				});
			}
		};
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: { output: null } })
		};
		const result = await bundle.dispatch(
			command('agents.cancel', { taskId: turnId }),
			{ scope, database, ai, tasks },
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success', response: { value: { cancelled: true } } });
		expect(
			statements.some(
				(entry) =>
					entry.sql.includes("jsonb_set(content, '{status}'") && entry.parameters[0] === turnId
			)
		).toBe(true);
		expect(
			statements.some((entry) => entry.sql.includes("update bolt_task set status = 'failed'"))
		).toBe(true);
	});
});
