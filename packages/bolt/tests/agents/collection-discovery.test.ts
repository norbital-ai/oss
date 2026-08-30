import { describe, expect, it } from 'vitest';
import type {
	AIRequest,
	AIResponse,
	DatabaseRequest,
	DatabaseResponse,
	FacilityBinding,
	FacilityBindings,
	Invocation,
	TaskRequest,
	TaskResponse
} from '@norbital-ai/bolt-protocol';
import {
	EnvironmentName,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';

const hiddenCollection = 'suspicious_activity_logs';
const scope = {
	tenantId: TenantId.make('tenant-discovery'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-discovery')
};

type StoredContent = Readonly<Record<string, unknown>> & {
	readonly parts: ReadonlyArray<unknown>;
};

type StoredToolResult = Readonly<Record<string, unknown>> & {
	readonly kind: 'tool-result';
	readonly name: string;
	readonly output: unknown;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isStoredContent = (value: unknown): value is StoredContent =>
	isRecord(value) && Array.isArray(value.parts);

const isDescribeWorkspaceResult = (value: unknown): value is StoredToolResult =>
	isRecord(value) &&
	value.kind === 'tool-result' &&
	value.name === 'describe_workspace' &&
	'output' in value;

const definition = workspace({
	name: 'least-authority-discovery',
	version: '1',
	collections: [
		collection({ name: 'job_assignments', fields: { title: field.string({ required: true }) } }),
		collection({ name: hiddenCollection, fields: { reason: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'field-envoy',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['*'] },
			grants: [
				{ collection: 'job_assignments', action: 'read' },
				{ collection: 'job_assignments', action: 'update', fields: ['title'] }
			]
		})
	],
	teams: { 'field-envoy': ['field-envoy'] },
	automations: [],
	envoys: [
		{
			name: 'whatsapp-field',
			transport: 'whatsapp',
			audience: 'public',
			policies: ['field-envoy'],
			task: 'Update only the assignment supplied by the sender.',
			delegation: 'disabled'
		}
	],
	integrations: [],
	prompt: 'You are a narrowly scoped field operations assistant.',
	tools: [],
	skills: [],
	requiredFacilities: ['database', 'ai', 'tasks', 'hostTools'],
	schemaFingerprint: 'sha256:collection-discovery-fixture'
});

describe('agent collection discovery', () => {
	it('does not reveal collection names outside the subject authority', async () => {
		const subject = {
			userId: 'envoy-like-user',
			tenantId: String(scope.tenantId),
			teamPath: ['field-envoy'],
			policies: []
		};
		const subjectRow = {
			id: subject.userId,
			tenantId: subject.tenantId,
			email: null,
			status: 'normal',
			team_id: 'team-field-envoy'
		};
		const teamRow = {
			id: 'team-field-envoy',
			name: 'field-envoy',
			parent_id: null,
			description: null
		};
		const persisted: Array<ReadonlyArray<unknown>> = [];
		let messageId = 0;
		let claimed = false;
		const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Query' && request.sql.includes('pg_advisory_xact_lock')) {
					if (claimed) {
						return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } });
					}
					claimed = true;
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								{
									task_id: 'collection-discovery:turn',
									conversation_id: 'conversation-discovery',
									turn_id: 'collection-discovery:turn',
									agent_name: 'whatsapp-field'
								}
							],
							affectedRows: 1
						}
					});
				}
				if (
					request._tag === 'Query' &&
					request.sql.includes('as mailbox_status') &&
					request.sql.includes('as has_running')
				) {
					return Promise.resolve({
						_tag: 'Success',
						value: { rows: [{ mailbox_status: 'active', has_running: false }], affectedRows: 0 }
					});
				}
				if (request._tag === 'Query' && request.sql.includes('from "auth_config"')) {
					return Promise.resolve({
						_tag: 'Success',
						value: { rows: [{ value: 'collection-discovery-test-secret' }], affectedRows: 0 }
					});
				}
				if (request._tag === 'Query' && request.sql.includes('from "session"')) {
					return Promise.resolve({
						_tag: 'Success',
						value: { rows: [subjectRow], affectedRows: 0 }
					});
				}
				if (request._tag === 'Query' && request.sql.includes('from "team"')) {
					return Promise.resolve({
						_tag: 'Success',
						value: { rows: [teamRow], affectedRows: 0 }
					});
				}
				if (request._tag === 'Query' && request.sql.includes('from "chat_session"')) {
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								{
									conversation_id: 'conversation-discovery',
									agent_name: 'whatsapp-field',
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
				if (
					request._tag === 'Query' &&
					request.sql.includes('chat_message') &&
					request.sql.includes('turn_id')
				) {
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: [
								{
									id: 'collection-discovery:turn:message',
									content: {
										id: 'collection-discovery:turn',
										status: 'running',
										parts: [],
										subject,
										agent_name: 'whatsapp-field',
										usage_unreported: false
									}
								}
							],
							affectedRows: 0
						}
					});
				}
				if (request._tag === 'Query' && request.sql.includes('chat_message')) {
					persisted.push(request.parameters);
					if (
						request.sql.trimStart().startsWith('insert') &&
						request.sql.includes('"chat_message"')
					) {
						messageId += 1;
						return Promise.resolve({
							_tag: 'Success',
							value: { rows: [{ id: `message-${messageId}` }], affectedRows: 1 }
						});
					}
				}
				return Promise.resolve({
					_tag: 'Success',
					value: { rows: [], affectedRows: 1 }
				});
			}
		};

		const offered: AIRequest[] = [];
		let round = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (_metadata, request) => {
				if (request._tag === 'Models') {
					return Promise.resolve({
						_tag: 'Success',
						value: { output: { defaultModel: 'test-model', options: [{ id: 'test-model', contextLength: 128_000 }] } }
					});
				}
				offered.push(request);
				round += 1;
				return Promise.resolve({
					_tag: 'Success',
					value: {
						output:
							round === 1
								? { toolCalls: [{ name: 'describe_workspace', input: {} }] }
								: { text: 'I can work with job assignments.' }
					}
				});
			}
		};
		const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
			call: () => Promise.resolve({ _tag: 'Success', value: {} })
		};
		const facilities: FacilityBindings = {
			scope,
			database,
			ai,
			tasks,
			hostTools: {
				call: () => Promise.resolve({ _tag: 'Success', value: { output: {} } })
			}
		};
		const bundle = makeBundle(
			definition,
			buildManifest(definition, { artifactId: 'discovery' }),
			{}
		);
		const invocation: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('collection-discovery'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'agents.enqueue',
			input: {
				agent: 'whatsapp-field',
				conversationId: 'conversation-discovery',
				turnId: 'collection-discovery:turn',
				message: 'Describe reachable collections'
			},
			headers: { authorization: ['Bearer envoy-test-session'] }
		};

		const result = await bundle.dispatch(invocation, facilities, new AbortController().signal);
		if (result._tag === 'Failure') throw new Error(JSON.stringify(result.error));
		expect(result).toMatchObject({ _tag: 'Success' });
		expect(offered).toHaveLength(2);

		const offeredSurface = JSON.stringify(offered[0]);
		expect(offeredSurface).toContain('Allowed collections: job_assignments');
		expect(offeredSurface).not.toContain(hiddenCollection);

		const rewrites = persisted
			.flatMap((parameters) => parameters)
			.filter((parameter): parameter is string => typeof parameter === 'string')
			.flatMap((parameter) => {
				try {
					const decoded: unknown = JSON.parse(parameter);
					return isStoredContent(decoded) ? [decoded] : [];
				} catch {
					return [];
				}
			});
		const toolResult = rewrites.at(-1)?.parts.find(isDescribeWorkspaceResult);
		expect(toolResult?.output).toMatchObject({
			collections: expect.arrayContaining(['job_assignments'])
		});
		expect(JSON.stringify(toolResult?.output)).not.toContain(hiddenCollection);
	});
});
