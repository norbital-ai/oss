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
	app,
	collection,
	describeMcpServer,
	field,
	policy,
	tool,
	workspace
} from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import { McpCallToolRequest } from '../../src/runtime/agents/agents.js';
import { IntegrationHttpRequest } from '../../src/runtime/integrations/http.js';

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
			capabilities: {
				apps: ['web'],
				tools: ['summarize'],
				mcp: ['search'],
				skills: ['payroll']
			}
		}),
		policy({
			name: 'admin-data',
			effect: 'allow',
			actions: ['read', 'create', 'update', 'delete'],
			capabilities: { apps: ['employees'] }
		})
	],
	teams: {
		'admin-agent': ['admin-agent'],
		'admin-data': ['admin-data'],
		admin: ['admin-agent', 'admin-data']
	},
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		...describeMcpServer('search', {
			url: 'https://mcp.example.test',
			tools: [
				{
					name: 'lookup',
					description: 'Search indexed records.',
					inputSchema: {
						type: 'object',
						properties: { q: { type: 'string' } },
						required: ['q']
					}
				}
			]
		})
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }],
	requiredFacilities: ['database', 'ai', 'tasks', 'hostTools'],
	mutationCompatibility: {
		offlineHorizonMillis: 14 * 24 * 60 * 60 * 1_000,
		currentSchemaFingerprint: 'sha256:tools-loop-fixture',
		adapters: []
	}
});
const manifest = buildManifest(definition, { artifactId: 'hr-tools' });
const bundle = makeBundle(definition, manifest, {});
const subject = { userId: 'admin-1', tenantId: 'tenant-1', teamPath: ['admin'], policies: [] };
const subjectRow = {
	id: subject.userId,
	tenantId: subject.tenantId,
	email: null,
	status: 'normal',
	team_id: 'team-admin'
};

type QueryStatement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;
type PersistedPart = Readonly<Record<string, unknown>> &
	Readonly<{
		kind: string;
		id?: unknown;
		name?: string;
	}>;
type PersistedTurn = Readonly<Record<string, unknown>> &
	Readonly<{
		readonly id: string;
		readonly status: string;
		readonly parts: ReadonlyArray<PersistedPart>;
	}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isPersistedPart = (value: unknown): value is PersistedPart =>
	isRecord(value) &&
	typeof value.kind === 'string' &&
	(value.name === undefined || typeof value.name === 'string');

const isPersistedTurn = (value: unknown): value is PersistedTurn =>
	isRecord(value) &&
	typeof value.id === 'string' &&
	typeof value.status === 'string' &&
	Array.isArray(value.parts) &&
	value.parts.every(isPersistedPart);

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

const jsonObjectParameter = (parameters: ReadonlyArray<unknown>): PersistedTurn | undefined => {
	for (const parameter of parameters) {
		let decoded = parameter;
		for (let depth = 0; depth < 2 && typeof decoded === 'string'; depth += 1) {
			try {
				decoded = JSON.parse(decoded);
			} catch {
				break;
			}
		}
		if (isPersistedTurn(decoded)) return decoded;
	}
	return undefined;
};

let returnedMessage = 0;
const admittedTurns = new Map<string, string>();
const claimedConversations = new Set<string>();
const turnConversations = new Map<string, string>();
const persistedTurns = new Map<string, PersistedTurn>();
const sessionDatabase: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
	call: (_metadata, request) => {
		const statements = request._tag === 'Query' ? [request] : request.statements;
		for (const statement of statements) {
			const persisted = jsonObjectParameter(statement.parameters);
			if (
				persisted !== undefined &&
				(statementIntent(statement, 'insert', 'chat_message') ||
					statementIntent(statement, 'update', 'chat_message'))
			) {
				persistedTurns.set(persisted.id, persisted);
			}
		}
		if (request._tag !== 'Query') {
			for (const statement of request.statements) {
				if (statementIntent(statement, 'insert', 'agent_run')) {
					const conversationId = String(statement.parameters[0]);
					const turnId = String(statement.parameters[1]);
					admittedTurns.set(conversationId, turnId);
					turnConversations.set(turnId, conversationId);
				}
			}
			const claim = request.statements.find((statement) =>
				statement.sql.includes('pg_advisory_xact_lock')
			);
			if (claim !== undefined) {
				const conversationId = String(claim.parameters[0] ?? '');
				if (claimedConversations.has(conversationId)) {
					return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } });
				}
				claimedConversations.add(conversationId);
				const turnId =
					admittedTurns.get(conversationId) ??
					`${conversationId.replace(/^conversation-/, 'agent-')}:turn`;
				turnConversations.set(turnId, conversationId);
				return Promise.resolve({
					_tag: 'Success',
					value: {
						rows: [
							{
								task_id: turnId,
								conversation_id: conversationId,
								turn_id: turnId,
								agent_name: 'web'
							}
						],
						affectedRows: 1
					}
				});
			}
			return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
		}
		if (request.sql.includes('pg_advisory_xact_lock')) {
			const conversationId = String(request.parameters[0] ?? '');
			if (claimedConversations.has(conversationId)) {
				return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } });
			}
			claimedConversations.add(conversationId);
			const turnId =
				admittedTurns.get(conversationId) ??
				`${conversationId.replace(/^conversation-/, 'agent-')}:turn`;
			turnConversations.set(turnId, conversationId);
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							task_id: turnId,
							conversation_id: conversationId,
							turn_id: turnId,
							agent_name: 'web'
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
		if (statementIntent(request, 'select', 'session')) {
			return Promise.resolve({ _tag: 'Success', value: { rows: [subjectRow], affectedRows: 0 } });
		}
		if (statementIntent(request, 'select', 'team')) {
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
		if (statementIntent(request, 'select', 'auth_config')) {
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ value: 'test-session-secret-that-is-long-enough' }], affectedRows: 0 }
			});
		}
		if (statementIntent(request, 'select', 'chat_session')) {
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
							parent_id: null
						}
					],
					affectedRows: 0
				}
			});
		}
		if (statementIntent(request, 'select', 'chat_message') && request.sql.includes('turn_id')) {
			// Drizzle may place literal predicates (for example `role = 'assistant'`) before
			// either identifier. Resolve the persisted target semantically instead of coupling
			// this facility double to a generated parameter order.
			const values = request.parameters.map(String);
			const turnId = values.find((value) => turnConversations.has(value)) ?? '';
			const conversationId =
				values.find((value) => [...turnConversations.values()].includes(value)) ?? '';
			const content =
				persistedTurns.get(turnId) ??
				(turnId === ''
					? undefined
					: {
							id: turnId,
							status: 'queued' as const,
							parent_agent_id: null,
							parts: [],
							subject,
							agent_name: 'web',
							usage_unreported: false
						});
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows:
						content === undefined || turnConversations.get(turnId) !== conversationId
							? []
							: [{ id: `${turnId}:message`, content }],
					affectedRows: 0
				}
			});
		}
		if (statementIntent(request, 'select', 'chat_message')) {
			const conversationId = String(request.parameters[0] ?? '');
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [...persistedTurns.entries()].flatMap(([turnId, content]) =>
						turnConversations.get(turnId) === conversationId
							? [{ id: `${turnId}:message`, role: 'assistant', content }]
							: []
					),
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
				if (request._tag === 'Query' && request.sql.includes('chat_message')) {
					written.push({ sql: request.sql, parameters: request.parameters });
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: {} })
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
			command: 'agents.run',
			input: {
				conversationId: 'conversation-tools'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { conversationId: 'conversation-tools', status: 'drained' } }
		});
		expect(turns).toBe(2);
		expect(Schema.decodeUnknownSync(BundleResult)(result)).toEqual(result);
		expect(hostCalls).toEqual([]);
		// Admission owns the one user row and one assistant row. Execution only rewrites that assistant
		// row as each tool step lands.
		const rewrites = written
			.filter((entry) => statementIntent(entry, 'update', 'chat_message'))
			.flatMap((entry) => {
				const turn = jsonObjectParameter(entry.parameters);
				return turn === undefined ? [] : [turn];
			});
		// Every rewrite addresses the one turn it belongs to.
		expect(new Set(rewrites.map((turn) => turn.id))).toEqual(new Set(['agent-tools:turn']));
		const finalTurn = rewrites.at(-1);
		expect(finalTurn).toMatchObject({ status: 'completed' });
		if (finalTurn === undefined) throw new Error('expected a completed persisted turn');
		const firstPart = finalTurn.parts[0];
		if (firstPart === undefined)
			throw new Error('expected the persisted turn to contain a tool call');
		expect(finalTurn.parts).toEqual([
			{
				kind: 'tool',
				id: expect.any(String),
				name: 'describe_workspace',
				input: {}
			},
			{
				kind: 'tool-result',
				id: firstPart.id,
				name: 'describe_workspace',
				output: expect.anything()
			},
			{ kind: 'text', text: 'Workspace has employees' }
		]);
		// The turn grows a part at a time rather than arriving whole, which is what lets a reader watch it.
		expect(rewrites.map((turn) => turn.parts.length)).toEqual([0, 1, 2, 3, 3]);
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
						? { toolCalls: [{ name: 'summarize', input: { path: 'src' } }] }
						: { text: 'One directory' };
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		// The log as the database holds it, replayed from the statements the loop issues. A read of the
		// real row at the moment the tool runs is what proves the write already landed.
		let stored: unknown = null;
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (metadata, request, signal) => {
				if (request._tag === 'Query' && request.sql.includes('chat_message')) {
					if (
						statementIntent(request, 'insert', 'chat_message') &&
						request.parameters.includes('assistant')
					) {
						stored = jsonObjectParameter(request.parameters);
					}
					if (statementIntent(request, 'update', 'chat_message')) {
						stored = jsonObjectParameter(request.parameters);
					}
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		let duringCall: unknown = null;
		const observedBundle = makeBundle(
			definition,
			manifest,
			{},
			{
				summarize: async () => {
					duringCall = stored;
					return { entries: ['src'] };
				}
			}
		);
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks: { call: () => Promise.resolve({ _tag: 'Success', value: {} }) }
		};
		const result = await observedBundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-streaming'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.run',
				input: {
					conversationId: 'conversation-streaming'
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
		if (!isPersistedTurn(duringCall)) throw new Error('expected a running persisted turn');
		expect(duringCall.parts.map((part) => part.kind)).toEqual(['tool']);
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
						? {
								text: 'Looking at the workspace',
								toolCalls: [{ name: 'describe_workspace', input: {} }]
							}
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
				if (request._tag === 'Query' && request.sql.includes('chat_message')) {
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
				command: 'agents.run',
				input: {
					conversationId: 'conversation-two-rounds'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			{
				scope,
				database,
				ai,
				tasks: { call: () => Promise.resolve({ _tag: 'Success', value: {} }) },
				hostTools: {
					call: () => Promise.resolve({ _tag: 'Success', value: { output: {} } })
				}
			},
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(turns).toBe(3);
		// Execution appends no replacement rows; both rounds rewrite the one admitted assistant row.
		expect(written.filter((entry) => statementIntent(entry, 'insert', 'chat_message'))).toEqual([]);
		const rewrites = written
			.filter((entry) => statementIntent(entry, 'update', 'chat_message'))
			.flatMap((entry) => {
				const turn = jsonObjectParameter(entry.parameters);
				return turn === undefined ? [] : [turn];
			});
		const settled = rewrites.at(-1);
		expect(settled).toMatchObject({ status: 'completed' });
		if (settled === undefined) throw new Error('expected a completed persisted turn');
		// The order is the turn's own order: what it said, what it called, what came back, twice over.
		expect(
			settled.parts.map((part) =>
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
		const [, firstCall, firstResult, secondCall, secondResult] = settled.parts;
		if (
			firstCall === undefined ||
			firstResult === undefined ||
			secondCall === undefined ||
			secondResult === undefined
		) {
			throw new Error('expected both tool calls and their persisted results');
		}
		expect(firstResult.id).toBe(firstCall.id);
		expect(secondResult.id).toBe(secondCall.id);
		// Grew a part at a time rather than arriving whole — the reader can watch each one land.
		expect(rewrites.map((turn) => turn.parts.length)).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
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
			call: () => Promise.resolve({ _tag: 'Success', value: {} })
		};
		const connectorCalls: Array<{
			connector: string;
			operation: string;
			input: unknown;
		}> = [];
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks,
			connector: {
				call: (_metadata, request) => {
					const http = Schema.decodeUnknownSync(IntegrationHttpRequest)(request.input);
					const called = Schema.decodeUnknownSync(McpCallToolRequest)(http.body);
					connectorCalls.push({
						connector: request.connector,
						operation: request.operation,
						input: request.input
					});
					return Promise.resolve({
						_tag: 'Success',
						value: {
							output: {
								status: 200,
								headers: { 'content-type': 'application/json' },
								body: {
									jsonrpc: '2.0',
									id: called.id,
									result: {
										resultType: 'complete',
										content: [{ type: 'text', text: '2 hits' }],
										structuredContent: { hits: 2 }
									}
								}
							}
						}
					});
				}
			}
		};
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('agent-mcp'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.run',
			input: {
				conversationId: 'conversation-mcp'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { conversationId: 'conversation-mcp', status: 'drained' } }
		});
		expect(connectorCalls).toEqual([
			{
				connector: 'search',
				operation: 'http.request',
				input: {
					method: 'POST',
					url: 'https://mcp.example.test',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						'mcp-protocol-version': '2026-07-28'
					},
					body: {
						jsonrpc: '2.0',
						id: expect.any(String),
						method: 'tools/call',
						params: {
							_meta: {
								'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								'io.modelcontextprotocol/clientCapabilities': {}
							},
							name: 'lookup',
							arguments: { q: 'payroll' }
						}
					}
				}
			}
		]);
	});

	it('refuses an undeclared tool even when its MCP server is granted', async () => {
		let turns = 0;
		let connectorCalls = 0;
		const result = await bundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-mcp-undeclared'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.run',
				input: {
					conversationId: 'conversation-mcp-undeclared'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			{
				scope,
				database: sessionDatabase,
				ai: {
					call: () => {
						turns += 1;
						return Promise.resolve({
							_tag: 'Success',
							value: {
								output:
									turns === 1
										? { toolCalls: [{ name: 'search:delete', input: {} }] }
										: { text: 'Refused' }
							}
						});
					}
				},
				tasks: {
					call: () => Promise.resolve({ _tag: 'Success', value: {} })
				},
				connector: {
					call: () => {
						connectorCalls += 1;
						return Promise.resolve({ _tag: 'Success', value: { output: null } });
					}
				}
			},
			new AbortController().signal
		);
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(connectorCalls).toBe(0);
	});

	it('spawns an in-session subagent and parks only at the explicit await', async () => {
		let turns = 0;
		const targetAgentId = 'agent:agent-spawn:turn:tool:0:0';
		const targetTaskId = 'agent-spawn:turn:tool:0:0';
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: () => {
				turns += 1;
				return Promise.resolve({
					_tag: 'Success',
					value: {
						output:
							turns === 1
								? {
										toolCalls: [{ name: 'spawn_agent', input: { task: 'Draft the offer' } }]
									}
								: turns === 2
									? {
											toolCalls: [
												{
													name: 'await_agent',
													input: { agentId: targetAgentId, taskId: targetTaskId }
												}
											]
										}
									: turns === 3
										? { text: 'Draft complete.' }
										: { text: 'Delegation complete.' }
					}
				});
			}
		};
		// The spawn is a durable `agent_run` admission and direct execution. The task facility is used
		// only for an in-memory interruption handle; no Wake may be emitted.
		const taskSignals: Array<string> = [];
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Wake') taskSignals.push('wake');
				return Promise.resolve({ _tag: 'Success', value: {} });
			}
		};
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (metadata, request, signal) => {
				if (
					request._tag === 'Query' &&
					statementIntent(request, 'select', 'chat_session') &&
					request.parameters.includes(targetAgentId)
				) {
					const relatedLookup = request.sql.startsWith('select "conversation_id", "parent_id"');
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								...(relatedLookup
									? [
											{
												conversation_id: 'conversation-spawn',
												parent_id: null,
												user_id: subject.userId,
												sandbox_key: subject.userId,
												agent_name: 'web',
												title: 'Delegate the offer'
											}
										]
									: []),
								{
									conversation_id: targetAgentId,
									parent_id: 'conversation-spawn',
									user_id: subject.userId,
									sandbox_key: subject.userId,
									agent_name: 'web',
									title: 'Draft the offer'
								}
							],
							affectedRows: 0
						}
					});
				}
				return sessionDatabase.call(metadata, request, signal);
			}
		};
		const facilities: FacilityBindings = { scope, database, ai, tasks };
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('agent-spawn'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.run',
			input: {
				conversationId: 'conversation-spawn'
			},
			headers: { authorization: ['Bearer test-session'] }
		};
		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { conversationId: 'conversation-spawn', status: 'drained' } }
		});
		expect(turns).toBe(4);
		expect(persistedTurns.get(targetTaskId)?.status).toBe('completed');
		expect(taskSignals).not.toContain('wake');
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
			call: () => Promise.resolve({ _tag: 'Success', value: {} })
		};
		const result = await toolsBundle.dispatch(
			{
				_tag: 'Command',
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make('agent-workspace-tool'),
				scope,
				deadlineEpochMs: Date.now() + 10_000,
				command: 'agents.run',
				input: {
					conversationId: 'conversation-workspace-tool'
				},
				headers: { authorization: ['Bearer test-session'] }
			},
			{ scope, database, ai, tasks },
			new AbortController().signal
		);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { conversationId: 'conversation-workspace-tool', status: 'drained' } }
		});
	});
});
