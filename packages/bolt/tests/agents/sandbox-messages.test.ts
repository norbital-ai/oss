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
import { agent, app, collection, field, policy, workspace } from '../../src/authoring/index.js';
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
			roles: ['admin'],
			apps: ['helper']
		})
	],
	agents: [agent({ name: 'helper', prompt: 'Help the HR team.', tools: [], skills: [] })],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: ['database', 'ai', 'tasks']
});
const manifest = buildManifest(definition, { artifactId: 'hr-sandbox-messages' });
const bundle = makeBundle(definition, manifest, {});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', roles: ['admin'], teams: [] };
const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } })
};

const sender = 'conversation-auth';
const recipient = 'conversation-migrations';

/** One row as a facility hands it back: JSON, like everything else that crosses that boundary. */
type Row = { readonly [column: string]: Schema.Json };

/**
 * The two conversations and one message log this exercise touches.
 *
 * Answers the real statements the runtime issues rather than a fixture of what they are believed to
 * return: the ownership check, the sender's own title, and the transcript the receiving turn replays.
 */
const store = (transcript: ReadonlyArray<Row>) => {
	const writes: Array<ReadonlyArray<unknown>> = [];
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
			if (request._tag !== 'Query') return answer([]);
			const id = String(request.parameters[0] ?? '');
			if (request.sql.includes('bolt_auth_session')) return answer([subject]);
			if (request.sql.includes('from bolt_conversations')) {
				const title = titles[id];
				if (title === undefined) return answer([]);
				return answer([{ id, user_id: subject.userId, agent_name: 'helper', title }]);
			}
			if (request.sql.includes('from bolt_agent_messages')) {
				return answer(id === sender ? transcript : []);
			}
			if (request.sql.startsWith('insert into bolt_agent_messages')) {
				writes.push(request.parameters);
			}
			return answer([]);
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
	input: { subject, agent: 'helper', conversationId, message },
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
		const delivered = writes.find((parameters) => parameters[0] === recipient);
		expect(delivered, 'the message never reached the recipient log').toBeDefined();
		// Written as encoded JSON, like every other row in this log — the column is `jsonb`.
		expect(() => JSON.parse(String(delivered?.[2]))).not.toThrow();
		expect(parseAgentMessage(JSON.parse(String(delivered?.[2])))).toEqual({
			kind: 'agent_message',
			from: {
				sessionId: sender,
				agentName: 'helper',
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
			from: { sessionId: recipient, agentName: 'helper', title: 'Migration and performance verification' },
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
