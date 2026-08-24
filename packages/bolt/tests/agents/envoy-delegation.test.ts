import { describe, expect, it } from 'vitest';
import {
	EnvironmentName,
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
	type Invocation,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import { sandboxToolSpecs } from '../../src/runtime/agents/sandbox-tools.js';

const scope = {
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};
const subject = {
	userId: 'operator-1',
	tenantId: 'tenant-1',
	teamPath: ['operator'],
	policies: []
};
type QueryStatement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;
const statementIntent = (statement: QueryStatement, operation: string, table: string): boolean => {
	const sql = statement.sql.replaceAll('"', '').replaceAll(/\s+/g, ' ').trim().toLowerCase();
	if (!sql.startsWith(`${operation.toLowerCase()} `)) return false;
	const target = table.toLowerCase();
	return (
		sql.includes(` from ${target}`) ||
		sql.includes(` into ${target}`) ||
		sql.includes(`update ${target} `)
	);
};
const definition = workspace({
	name: 'field-operations',
	version: '1.0.0',
	collections: [],
	apps: [],
	policies: [
		policy({
			name: 'operator',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['*'] }
		})
	],
	teams: { operator: ['operator'] },
	automations: [],
	envoys: [
		envoy({
			name: 'ingress',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			task: 'Record field updates.',
			delegation: 'disabled'
		}),
		envoy({
			name: 'desk',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			task: 'Coordinate field support.'
		})
	],
	integrations: [],
	prompt: 'You are the field operations agent.',
	tools: [],
	skills: [],
	requiredFacilities: ['database', 'ai', 'tasks', 'hostTools']
});
const bundle = makeBundle(
	definition,
	buildManifest(definition, { artifactId: 'envoy-delegation' }),
	{}
);

const turn = (id: string, agent: string): Invocation => ({
	_tag: 'Command',
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make(id),
	scope,
	deadlineEpochMs: Date.now() + 10_000,
	command: 'agents.turn',
	input: {
		subject,
		agent,
		conversationId: `${agent}-conversation`,
		message: 'Handle this update.'
	},
	headers: { authorization: ['Bearer test-session'] }
});

describe('envoy delegation boundary', () => {
	it('omits every sandbox tool and rejects a disabled envoy calling one directly', async () => {
		const requests: Array<AIRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				requests.push(request);
				const output: AIResponse['output'] =
					requests.length === 1
						? {
								toolCalls: [
									{
										name: 'spawn_subagent',
										input: { task: 'Do work outside this ingress boundary.' }
									}
								]
							}
						: { text: 'Handled without delegation.' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		let queued = 0;
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => {
				queued += 1;
				return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } });
			}
		};
		let returnedMessage = 0;
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				if (request._tag !== 'Query') {
					return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
				}
				if (statementIntent(request, 'select', 'session')) {
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								{
									id: subject.userId,
									tenantId: subject.tenantId,
									email: null,
									status: 'normal',
									team_id: 'team-operator'
								}
							],
							affectedRows: 0
						}
					});
				}
				if (statementIntent(request, 'select', 'team')) {
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								{
									id: 'team-operator',
									name: subject.teamPath[0],
									parent_id: null,
									description: null
								}
							],
							affectedRows: 0
						}
					});
				}
				if (statementIntent(request, 'select', 'auth_config')) {
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [{ value: 'test-session-secret-that-is-long-enough' }],
							affectedRows: 0
						}
					});
				}
				if (statementIntent(request, 'insert', 'chat_message')) {
					returnedMessage += 1;
					return Promise.resolve({
						_tag: 'Success',
						value: { rows: [{ id: `message-${returnedMessage}` }], affectedRows: 1 }
					});
				}
				return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
			}
		};
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks,
			hostTools: {
				call: () => Promise.resolve({ _tag: 'Success', value: { output: null } })
			}
		};

		const result = await bundle.dispatch(
			turn('disabled-envoy-turn', 'ingress'),
			facilities,
			new AbortController().signal
		);

		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { status: 'completed', output: { text: 'Handled without delegation.' } } }
		});
		const firstRequest = requests[0];
		const secondRequest = requests[1];
		if (firstRequest?._tag !== 'Turn' || secondRequest?._tag !== 'Turn') {
			throw new Error('Agent execution did not issue the expected AI turns');
		}
		const sandboxNames = sandboxToolSpecs.map(({ name }) => name);
		const offered = firstRequest.tools;
		const offeredNames = offered.map((entry) => (entry as { name: string }).name);
		expect(offeredNames.filter((name) => sandboxNames.includes(name))).toEqual([]);
		const toolAnswer = secondRequest.messages.find(
			(message) =>
				typeof message === 'object' &&
				message !== null &&
				(message as { role?: string }).role === 'tool'
		) as { readonly content?: string } | undefined;
		expect(toolAnswer?.content).toContain('spawn_subagent');
		expect(toolAnswer?.content).toContain('not allowed');
		expect(queued).toBe(0);

		await bundle.dispatch(
			turn('default-envoy-turn', 'desk'),
			facilities,
			new AbortController().signal
		);
		const defaultRequest = requests.at(-1);
		if (defaultRequest?._tag !== 'Turn') {
			throw new Error('Default envoy execution did not issue an AI turn');
		}
		const defaultOffer = defaultRequest.tools;
		expect(defaultOffer.map((entry) => (entry as { name: string }).name)).toEqual(
			expect.arrayContaining(sandboxNames)
		);
	});
});
