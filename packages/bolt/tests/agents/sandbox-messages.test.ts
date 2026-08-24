import { describe, expect, it } from 'vitest';
import type { Schema } from 'effect';
import {
	PROTOCOL_VERSION,
	type AIRequest,
	type AIResponse,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityBindings,
	type Invocation,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { EnvironmentName, InvocationId, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import { parseAgentMessage } from '../../src/runtime/agents/agent-message.js';

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
const manifest = buildManifest(definition, { artifactId: 'hr-sandbox-messages' });
const bundle = makeBundle(definition, manifest, {});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', teamPath: ['admin'], policies: [] };
const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } })
};

const sender = 'conversation-auth';
const recipient = 'conversation-migrations';

/** One row as a facility hands it back: JSON, like everything else that crosses that boundary. */
type Row = { readonly [column: string]: Schema.Json };
type Statement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;

/** Matches Drizzle's intent without depending on quoting, aliases, or formatted whitespace. */
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

const jsonParameter = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const authRows = (statement: Statement): ReadonlyArray<Row> | undefined => {
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

/**
 * The two conversations and one message log this exercise touches.
 *
 * Answers the real statements the runtime issues rather than a fixture of what they are believed to
 * return: the ownership check, the sender's own title, and the transcript the receiving turn replays.
 */
const store = (transcript: ReadonlyArray<Row>) => {
	const writes: Array<Statement> = [];
	const titles: Readonly<Record<string, string>> = {
		[sender]: 'Wrote bolt-owned auth module',
		[recipient]: 'Migration and performance verification'
	};
	const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
		call: (_metadata, request) => {
			const answer = (rows: ReadonlyArray<Row>) =>
				Promise.resolve({
					_tag: 'Success' as const,
					value: { rows, affectedRows: rows.length }
				});
			const requested =
				request._tag === 'Query'
					? [{ sql: request.sql, parameters: request.parameters }]
					: request.statements;
			let rows: ReadonlyArray<Row> = [];
			let inserted = 0;
			for (const entry of requested) {
				const statement = { sql: entry.sql, parameters: entry.parameters } satisfies Statement;
				const authenticated = authRows(statement);
				if (authenticated !== undefined) {
					rows = authenticated;
					continue;
				}
				const id = statement.parameters.find(
					(parameter) => parameter === sender || parameter === recipient
				);
				if (operationOn(statement, 'select', 'chat_session')) {
					const conversationId = typeof id === 'string' ? id : sender;
					const title = titles[conversationId];
					rows =
						title === undefined
							? []
							: [
									{
										conversation_id: conversationId,
										parent_id: null,
										user_id: subject.userId,
										sandbox_key: subject.userId,
										agent_name: 'web',
										title
									}
								];
					continue;
				}
				if (operationOn(statement, 'select', 'chat_message')) {
					rows = id === sender ? transcript : [];
					continue;
				}
				if (operationOn(statement, 'insert', 'chat_message')) {
					writes.push(statement);
					inserted += 1;
					rows = [{ id: `message-${inserted}` }];
				}
			}
			return answer(rows);
		}
	};
	return { database, writes };
};

const turn = (conversationId: string, message: string): Invocation => ({
	_tag: 'Command',
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make('agent-sandbox-message'),
	scope,
	deadlineEpochMs: Date.now() + 10_000,
	command: 'agents.turn',
	input: { subject, agent: 'web', conversationId, message },
	headers: { authorization: ['Bearer test-session'] }
});

describe('messages between sandbox agent sessions', () => {
	/**
	 * The message is written into the recipient's log with the session that sent it.
	 *
	 * Both halves matter. The text went in unquoted, which is not JSON, so a `jsonb` column rejected
	 * every delivery while the tool answered `delivered: true`. And a message stored as bare text is
	 * indistinguishable, afterwards, from something the person typed — there is nowhere left to read
	 * who sent it.
	 */
	it('stores a delivered message with the sender that wrote it', async () => {
		let round = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				round += 1;
				const output: AIResponse['output'] =
					round === 1
						? {
								toolCalls: [
									{
										name: 'message_sandbox_agent',
										input: { sessionId: recipient, message: 'Those four are already fixed.' }
									}
								]
							}
						: { text: 'Told them.' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		const { database, writes } = store([]);
		const facilities: FacilityBindings = { scope, database, ai, tasks };
		const result = await bundle.dispatch(
			turn(sender, 'Reply to the migration agent'),
			facilities,
			new AbortController().signal
		);
		expect(result, JSON.stringify(result)).toMatchObject({ _tag: 'Success' });
		const delivered = writes.find(
			(statement) =>
				operationOn(statement, 'insert', 'chat_message') && statement.parameters.includes(recipient)
		);
		expect(delivered, 'the message never reached the recipient log').toBeDefined();
		// Locate the JSON payload by shape rather than coupling this assertion to a parameter index.
		const storedMessage = delivered?.parameters
			.map(jsonParameter)
			.map(parseAgentMessage)
			.find((message) => message !== null);
		expect(storedMessage).toEqual({
			kind: 'agent_message',
			from: {
				sessionId: sender,
				agentName: 'web',
				title: 'Wrote bolt-owned auth module'
			},
			text: 'Those four are already fixed.'
		});
	});

	/**
	 * The receiving model is told who wrote it.
	 *
	 * The log stores it in the `user` role because that is the only role available for words the session
	 * did not produce. Replayed as-is it is a claim that the person asked for this, which is the one
	 * thing a message from another agent must not be able to say.
	 */
	it('attributes a received message in the prompt instead of passing it off as the person', async () => {
		const stored = {
			kind: 'agent_message',
			from: {
				sessionId: recipient,
				agentName: 'web',
				title: 'Migration and performance verification'
			},
			text: 'Heads-up: four errors in auth-store.ts'
		};
		let prompt: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Turn') {
					prompt = request.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
				}
				return Promise.resolve({ _tag: 'Success', value: { output: { text: 'Looking.' } } });
			}
		};
		const { database } = store([{ role: 'user', content: stored }]);
		const facilities: FacilityBindings = { scope, database, ai, tasks };
		const result = await bundle.dispatch(
			turn(sender, 'Anything outstanding?'),
			facilities,
			new AbortController().signal
		);
		expect(result, JSON.stringify(result)).toMatchObject({ _tag: 'Success' });
		const relayed = prompt.find(
			(message) => typeof message.content === 'string' && message.content.includes(stored.text)
		);
		expect(relayed, 'the relayed message never reached the prompt').toBeDefined();
		expect(String(relayed?.content)).toContain('Migration and performance verification');
		expect(String(relayed?.content)).toContain(recipient);
		// A stored record handed straight to the provider is an object where a string belongs.
		expect(typeof relayed?.content).toBe('string');
	});
});
