import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	PROTOCOL_VERSION,
	type AIRequest,
	type AIResponse,
	BundleResult,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityBindings,
	type Invocation,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { EnvironmentName, InvocationId, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import {
	agent,
	app,
	collection,
	field,
	policy,
	tool,
	workspace
} from '../../src/authoring/index.js';
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
			roles: ['admin'],
			apps: ['helper']
		}),
		policy({
			name: 'admin-data',
			effect: 'allow',
			actions: ['read', 'create', 'update', 'delete'],
			roles: ['admin'],
			apps: ['employees']
		})
	],
	agents: [
		agent({
			name: 'helper',
			prompt: 'Help the HR team.',
			tools: [
				tool({
					name: 'sandbox_ls',
					description: 'List workbench files',
					command: 'host:sandbox_ls'
				}),
				tool({
					name: 'summarize',
					description: 'Summarize records',
					command: 'workspace:summarize'
				})
			],
			skills: []
		})
	],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: ['database', 'ai', 'tasks', 'hostTools']
});
const manifest = buildManifest(definition, { artifactId: 'hr-tools' });
const bundle = makeBundle(definition, manifest, {});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', roles: ['admin'], teams: [] };
const sessionDatabase: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
	call: (_metadata, request) => {
		// Authentication reads Better Auth's session joined to its user table. Matching on
		// `bolt_auth_session` keeps this stub answering the query identity actually makes; matching
		// the old `bolt_sessions` would have it answer nothing and every command would read as
		// unauthenticated.
		if (request._tag === 'Query' && request.sql.includes('bolt_auth_session')) {
			return Promise.resolve({ _tag: 'Success', value: { rows: [subject], affectedRows: 0 } });
		}
		return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
	}
};

describe('Bolt agent tool loop', () => {
	it('executes describe_workspace then completes the turn', async () => {
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { toolCalls: [{ name: 'describe_workspace', input: {} }] }
						: { text: 'Workspace has employees' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		// Recorded rather than discarded: the panel projects tool parts out of exactly these rows, so a
		// fixture of what they are believed to hold would prove nothing about what is written.
		const written: Array<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }> =
			[];
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (metadata, request, signal) => {
				if (request._tag === 'Query' && request.sql.includes('bolt_agent_messages')) {
					written.push({ sql: request.sql, parameters: request.parameters });
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } })
		};
		const hostCalls: Array<string> = [];
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks,
			hostTools: {
				call: (_metadata, request) => {
					hostCalls.push(request.tool);
					return Promise.resolve({ _tag: 'Success', value: { output: { entries: ['src'] } } });
				}
			}
		};
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('agent-tools'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.turn',
			input: {
				subject,
				agent: 'helper',
				conversationId: 'conversation-tools',
				message: 'What collections exist?'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { output: { text: 'Workspace has employees' }, status: 'completed' } }
		});
		expect(turns).toBe(2);
		expect(Schema.decodeUnknownSync(BundleResult)(result)).toEqual(result);
		expect(hostCalls).toEqual([]);
		// The conversation log is what replicates to the panel, so the turn and the call it made have to
		// be in it: one assistant message per turn, and a call and its answer sharing an id so the two can
		// be paired.
		const appended = written
			.filter((entry) => entry.sql.startsWith('insert'))
			.map((entry) => ({
				role: entry.parameters[1],
				content: JSON.parse(String(entry.parameters[2]))
			}));
		// One row per turn. It used to be one per round, which rendered this turn as two agent blocks.
		expect(appended.map((entry) => entry.role)).toEqual(['user', 'assistant']);
		expect(appended[1]?.content).toMatchObject({ status: 'running', subagent_id: null, parts: [] });
		const rewrites = written
			.filter((entry) => entry.sql.startsWith('update'))
			.map((entry) => JSON.parse(String(entry.parameters[2])));
		// Every rewrite addresses the one turn it belongs to.
		expect(new Set(rewrites.map((turn) => turn.id))).toEqual(new Set([appended[1]?.content.id]));
		const finalTurn = rewrites.at(-1);
		expect(finalTurn).toMatchObject({ status: 'completed' });
		expect(finalTurn.parts).toEqual([
			{
				kind: 'tool',
				id: expect.any(String),
				name: 'describe_workspace',
				input: {}
			},
			{
				kind: 'tool-result',
				id: finalTurn.parts[0].id,
				name: 'describe_workspace',
				output: expect.anything()
			},
			{ kind: 'text', text: 'Workspace has employees' }
		]);
		// The turn grows a part at a time rather than arriving whole, which is what lets a reader watch it.
		expect(rewrites.map((turn) => turn.parts.length)).toEqual([1, 2, 3, 3]);
	});

	/**
	 * A part is durable before the turn settles.
	 *
	 * Checked from inside the tool the turn calls, because that is the only moment that distinguishes a
	 * loop which commits as it goes from one which commits at the end: the call has been made, its
	 * answer has not come back, and the turn is still `running`. An assertion on the final state would
	 * pass either way — and did, while the panel showed nothing until the whole turn returned.
	 */
	it('has the call durable and the turn still running while the tool is executing', async () => {
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { toolCalls: [{ name: 'sandbox_ls', input: { path: 'src' } }] }
						: { text: 'One directory' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		// The log as the database holds it, replayed from the statements the loop issues. A read of the
		// real row at the moment the tool runs is what proves the write already landed.
		let stored: unknown = null;
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (metadata, request, signal) => {
				if (request._tag === 'Query' && request.sql.includes('bolt_agent_messages')) {
					if (request.sql.startsWith('insert') && request.parameters[1] === 'assistant') {
						stored = JSON.parse(String(request.parameters[2]));
					}
					if (request.sql.startsWith('update')) stored = JSON.parse(String(request.parameters[2]));
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		let duringCall: unknown = null;
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks: { call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } }) },
			hostTools: {
				call: () => {
					duringCall = stored;
					return Promise.resolve({ _tag: 'Success', value: { output: { entries: ['src'] } } });
				}
			}
		};
		const result = await bundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-streaming'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.turn',
				input: {
					subject,
					agent: 'helper',
					conversationId: 'conversation-streaming',
					message: 'List the source directory'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			facilities,
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		// Observed mid-turn: the call is already in the log, the turn has not settled, and no answer has
		// been written for a call that has not returned.
		expect(duringCall).toMatchObject({ status: 'running' });
		const parts = (duringCall as { readonly parts: ReadonlyArray<{ readonly kind: string }> }).parts;
		expect(parts.map((part) => part.kind)).toEqual(['tool']);
		expect(stored).toMatchObject({ status: 'completed' });
	});

	/**
	 * Two rounds are one turn, so they are one message.
	 *
	 * The round is an artefact of how the tool loop is driven — the model answered with calls, so the
	 * loop went round again. The reader asked one question and got one answer, and the log used to open
	 * an `assistant` row per round, which rendered that single answer as two separate agent blocks. The
	 * count of inserted assistant rows is the assertion that matters; the ordered parts are what makes
	 * the single row still say which call came first.
	 */
	it('writes a two-round turn as one assistant message whose parts are in order', async () => {
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { text: 'Looking at the workspace', toolCalls: [{ name: 'describe_workspace', input: {} }] }
						: turns === 2
							? { toolCalls: [{ name: 'list_skills', input: {} }] }
							: { text: 'Two employees, no skills' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		const written: Array<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }> =
			[];
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (metadata, request, signal) => {
				if (request._tag === 'Query' && request.sql.includes('bolt_agent_messages')) {
					written.push({ sql: request.sql, parameters: request.parameters });
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		const result = await bundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-two-rounds'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.turn',
				input: {
					subject,
					agent: 'helper',
					conversationId: 'conversation-two-rounds',
					message: 'Describe the workspace and list skills'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			{
				scope,
				database,
				ai,
				tasks: { call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } }) },
				hostTools: {
					call: () => Promise.resolve({ _tag: 'Success', value: { output: {} } })
				}
			},
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(turns).toBe(3);
		const appended = written
			.filter((entry) => entry.sql.startsWith('insert'))
			.map((entry) => String(entry.parameters[1]));
		// One assistant row for two rounds. Two rows here is the defect this test exists for.
		expect(appended).toEqual(['user', 'assistant']);
		const rewrites = written
			.filter((entry) => entry.sql.startsWith('update'))
			.map((entry) => JSON.parse(String(entry.parameters[2])));
		const settled = rewrites.at(-1);
		expect(settled).toMatchObject({ status: 'completed' });
		// The order is the turn's own order: what it said, what it called, what came back, twice over.
		expect(
			settled.parts.map((part: { readonly kind: string; readonly name?: string }) =>
				part.name === undefined ? part.kind : `${part.kind}:${part.name}`
			)
		).toEqual([
			'text',
			'tool:describe_workspace',
			'tool-result:describe_workspace',
			'tool:list_skills',
			'tool-result:list_skills',
			'text'
		]);
		// Every part belongs to the one turn, and the answers name the calls they answer.
		expect(new Set(rewrites.map((turn) => turn.id)).size).toBe(1);
		expect(settled.parts[2].id).toBe(settled.parts[1].id);
		expect(settled.parts[4].id).toBe(settled.parts[3].id);
		// Grew a part at a time rather than arriving whole — the reader can watch each one land.
		expect(rewrites.map((turn) => turn.parts.length)).toEqual([2, 3, 4, 5, 6, 6]);
	});

	it('executes MCP tools through the connector facility', async () => {
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { toolCalls: [{ name: 'search:lookup', input: { q: 'payroll' } }] }
						: { text: 'Found 2 hits' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		const database = sessionDatabase;
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-mcp' } })
		};
		const connectorCalls: Array<{ connector: string; operation: string }> = [];
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks,
			connector: {
				call: (_metadata, request) => {
					connectorCalls.push({ connector: request.connector, operation: request.operation });
					return Promise.resolve({ _tag: 'Success', value: { output: { hits: 2 } } });
				}
			}
		};
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('agent-mcp'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.turn',
			input: {
				subject,
				agent: 'helper',
				conversationId: 'conversation-mcp',
				message: 'Search payroll'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { output: { text: 'Found 2 hits' }, status: 'completed' } }
		});
		expect(connectorCalls).toEqual([{ connector: 'search', operation: 'lookup' }]);
	});

	it('spawns an in-session subagent and parks the parent turn', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () =>
				Promise.resolve({
					_tag: 'Success',
					value: {
						output: { toolCalls: [{ name: 'spawn_subagent', input: { task: 'Draft the offer' } }] }
					}
				})
		};
		const database = sessionDatabase;
		const enqueued: Array<string> = [];
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Enqueue') enqueued.push(request.command);
				return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-spawn' } });
			}
		};
		const facilities: FacilityBindings = { scope, database, ai, tasks };
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('agent-spawn'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.turn',
			input: {
				subject,
				agent: 'helper',
				conversationId: 'conversation-spawn',
				message: 'Delegate the offer'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { status: 'waiting', output: { waiting: true } } }
		});
		expect(enqueued).toContain('agents.turn');
	});

	it('executes compiled workspace tool handlers', async () => {
		const toolsBundle = makeBundle(
			definition,
			manifest,
			{},
			{
				summarize: async () => ({ summary: 'done' })
			}
		);
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { toolCalls: [{ name: 'summarize', input: { limit: 3 } }] }
						: { text: 'Summarized' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		const database = sessionDatabase;
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: { taskId: 'task-tool' } })
		};
		const result = await toolsBundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-workspace-tool'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.turn',
				input: {
					subject,
					agent: 'helper',
					conversationId: 'conversation-workspace-tool',
					message: 'Summarize tickets'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			{ scope, database, ai, tasks },
			new AbortController().signal
		);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { output: { text: 'Summarized' }, status: 'completed' } }
		});
	});
});
