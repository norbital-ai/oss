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

/** Matches the operation Drizzle composed without coupling the fixture to quoting or whitespace. */
const operationOn = (
	statement: Pick<Statement, 'sql'>,
	operation: 'select' | 'insert' | 'update',
	table: string
): boolean => {
	const sql = statement.sql.replaceAll('"', '').replace(/\s+/g, ' ').trim().toLowerCase();
	const marker =
		operation === 'select'
			? ` from ${table}`
			: operation === 'insert'
				? ` into ${table}`
				: `update ${table}`;
	return sql.startsWith(operation) && sql.includes(marker);
};

const selectsColumn = (
	statement: Pick<Statement, 'sql'>,
	table: string,
	column: string
): boolean => {
	const projection = statement.sql.replaceAll('"', '').split(/\sfrom\s/i)[0] ?? '';
	return new RegExp(`(?:${table}\\.)?${column}\\b`, 'i').test(projection);
};

const hasParameter = (statement: Statement, value: unknown): boolean =>
	statement.parameters.some((parameter) => parameter === value);

/** JSON parameters may be values or jsonb-encoded strings; decode either facility representation. */
const jsonParameter = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const objectParameter = (statement: Statement): JsonObject | undefined =>
	statement.parameters
		.map(jsonParameter)
		.find(
			(value): value is JsonObject =>
				typeof value === 'object' && value !== null && !Array.isArray(value)
		);

const authRows = (statement: Statement): ReadonlyArray<JsonObject> | undefined => {
	if (operationOn(statement, 'select', 'auth_config')) {
		return [{ value: 'test-session-secret-that-is-long-enough-for-better-auth' }];
	}
	if (operationOn(statement, 'select', 'session')) {
		return [
			{
				id: subject.userId,
				tenantId: subject.tenantId,
				email: null,
				status: 'normal',
				team_id: 'team-admin'
			}
		];
	}
	if (operationOn(statement, 'select', 'team')) {
		return [{ id: 'team-admin', name: 'admin', parent_id: null, description: null }];
	}
	return undefined;
};

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
			const requested =
				request._tag === 'Query'
					? [{ sql: request.sql, parameters: request.parameters }]
					: request.statements;
			let rows: ReadonlyArray<JsonObject> = [];
			for (const entry of requested) {
				const statement = { sql: entry.sql, parameters: entry.parameters } satisfies Statement;
				statements.push(statement);
				const authenticated = authRows(statement);
				if (authenticated !== undefined) {
					rows = authenticated;
					continue;
				}
				if (operationOn(statement, 'select', 'chat_session')) {
					if (selectsColumn(statement, 'chat_session', 'conversation_id')) {
						const conversationId = hasParameter(statement, childId) ? childId : parentId;
						rows = [
							{
								conversation_id: conversationId,
								parent_id: conversationId === childId ? parentId : null,
								sandbox_key: subject.userId
							}
						];
					} else if (selectsColumn(statement, 'chat_session', 'parent_id')) {
						rows =
							authorized && hasParameter(statement, childId)
								? [
										{
											parent_id: parentId,
											user_id: subject.userId,
											sandbox_key: subject.userId
										}
									]
								: [{ parent_id: null }];
					} else if (selectsColumn(statement, 'chat_session', 'sandbox_key')) {
						rows = [{ sandbox_key: subject.userId }];
					} else if (selectsColumn(statement, 'chat_session', 'user_id')) {
						rows = [{ user_id: subject.userId }];
					}
					continue;
				}
				if (operationOn(statement, 'select', 'chat_message')) {
					if (hasParameter(statement, childId)) {
						rows = [{ content: targetTurn }];
					} else if (selectsColumn(statement, 'chat_message', 'id')) {
						rows = [{ id: 'parked-message', content: current }];
					} else {
						rows = [
							{ role: 'user', content: 'Please delegate the draft.' },
							{ role: 'assistant', content: current }
						];
					}
					continue;
				}
				if (operationOn(statement, 'update', 'chat_message')) {
					const content = objectParameter(statement);
					if (content !== undefined) current = content;
				}
			}
			return answer(rows);
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
			store.statements.filter((entry) => operationOn(entry, 'insert', 'chat_message'))
		).toEqual([]);
		const usage = store.statements.find(
			(entry) =>
				operationOn(entry, 'update', 'chat_session') && entry.sql.includes('usage_total_tokens')
		);
		// Only the resumed segment is added, and it is still one logical turn (`turnsCounted = 0`).
		expect(usage?.parameters).toEqual(expect.arrayContaining([parentId, 0.2, 20]));

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
		let insertedMessages = 0;
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				const requested =
					request._tag === 'Query'
						? [{ sql: request.sql, parameters: request.parameters }]
						: request.statements;
				let rows: ReadonlyArray<JsonObject> = [];
				for (const entry of requested) {
					const statement = { sql: entry.sql, parameters: entry.parameters } satisfies Statement;
					statements.push(statement);
					const authenticated = authRows(statement);
					if (authenticated !== undefined) {
						rows = authenticated;
					} else if (
						operationOn(statement, 'select', 'chat_session') &&
						selectsColumn(statement, 'chat_session', 'parent_id')
					) {
						rows = [{ parent_id: parentId }];
					} else if (operationOn(statement, 'insert', 'chat_message')) {
						insertedMessages += 1;
						rows = [{ id: `message-${insertedMessages}` }];
					} else {
						rows = [];
					}
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
		const enqueue = statements.find((entry) => operationOn(entry, 'insert', 'bolt_task'));
		expect(enqueue).toBeDefined();
		expect(enqueue?.parameters).toContain('agents.resume');
		expect(enqueue?.parameters).toContain('command-agents.turn:resume-parent');
		expect(enqueue?.parameters.map(jsonParameter)).toContainEqual({
			conversationId: parentId,
			targetSessionId: childId
		});
	});

	it('persists cancellation on the turn as well as cancelling queued work', async () => {
		const statements: Array<Statement> = [];
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				const requested =
					request._tag === 'Query'
						? [{ sql: request.sql, parameters: request.parameters }]
						: request.statements;
				let rows: ReadonlyArray<JsonObject> = [];
				for (const entry of requested) {
					const statement = { sql: entry.sql, parameters: entry.parameters } satisfies Statement;
					statements.push(statement);
					const authenticated = authRows(statement);
					if (authenticated !== undefined) {
						rows = authenticated;
					} else if (operationOn(statement, 'select', 'chat_message')) {
						rows = [{ id: 'parked-message', content: parkedTurn() }];
					} else {
						rows = [];
					}
				}
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
					operationOn(entry, 'update', 'chat_message') &&
					objectParameter(entry)?.status === 'cancelled'
			)
		).toBe(true);
		expect(
			statements.some(
				(entry) =>
					operationOn(entry, 'update', 'bolt_task') &&
					hasParameter(entry, 'failed') &&
					hasParameter(entry, turnId)
			)
		).toBe(true);
	});
});
