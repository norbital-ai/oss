import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	PROTOCOL_VERSION,
	type AIRequest,
	type AIResponse,
	type Activation,
	BundleResult,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityBindings,
	type Invocation,
	PluginTrustedContext,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { EnvironmentName, InvocationId, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
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
	apps: [app({ name: 'hr', label: 'HR' }), app({ name: 'finance', label: 'Finance' })],
	policies: [
		policy({
			name: 'employee-app',
			effect: 'allow',
			actions: ['view'],
			capabilities: { apps: ['hr'] }
		}),
		policy({
			name: 'admin-approval',
			effect: 'allow',
			actions: ['approve'],
			capabilities: { apps: ['approvals'] }
		}),
		policy({
			name: 'admin-sync',
			effect: 'allow',
			actions: ['sync'],
			capabilities: { apps: ['*'] }
		}),
		policy({
			name: 'admin-agent',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['web'] }
		}),
		policy({
			name: 'admin-data',
			effect: 'allow',
			actions: ['read', 'create', 'update', 'delete'],
			capabilities: { apps: ['employees'] }
		})
	],
	teams: {
		'employee-app': ['employee-app'],
		'admin-approval': ['admin-approval'],
		'admin-sync': ['admin-sync'],
		'admin-agent': ['admin-agent'],
		'admin-data': ['admin-data'],
		admin: ['employee-app', 'admin-approval', 'admin-sync', 'admin-agent', 'admin-data']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database', 'ai', 'tasks']
});
const manifest = buildManifest(definition, { artifactId: 'hr-fixture' });
const bundle = makeBundle(definition, manifest, {
	echo: (input) => Promise.resolve({ input, source: 'authored-remote' })
});

let chatMessageId = 0;
const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
	call: (_metadata, request) => {
		// Authentication reads Better Auth's session joined to its user table. The Drizzle query
		// returns the physical user projection; identity then resolves that row's team separately.
		if (request._tag === 'Query' && request.sql.includes('from "session"')) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							id: subject.userId,
							tenantId: subject.tenantId,
							email: null,
							status: 'admin',
							team_id: 'team-admin'
						}
					],
					affectedRows: 0
				}
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.startsWith('select "id", "name", "parent_id", "description" from "team"')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							id: 'team-admin',
							name: 'admin',
							parent_id: null,
							description: null
						},
						{
							id: 'team-employee-app',
							name: 'employee-app',
							parent_id: null,
							description: null
						}
					],
					affectedRows: 0
				}
			});
		}
		// `startSession` admits the subject before minting, and refuses when no row comes back.
		if (request._tag === 'Query' && request.sql.includes('update "user"')) {
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ id: subject.userId }], affectedRows: 1 }
			});
		}
		if (request._tag === 'Query' && request.sql.includes('insert into "bolt_approvals"')) {
			const state: Schema.Json | undefined = request.parameters.find(
				(parameter) =>
					typeof parameter === 'object' &&
					parameter !== null &&
					!Array.isArray(parameter) &&
					Reflect.get(parameter, '_tag') === 'Pending'
			);
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: state === undefined ? [] : [{ state }],
					affectedRows: 1
				}
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.startsWith('select "state" from "bolt_approvals"')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							state: {
								_tag: 'Pending',
								requestId: 'approval-1',
								step: 0,
								operation: {}
							}
						}
					],
					affectedRows: 0
				}
			});
		}
		if (request._tag === 'Query' && request.sql.includes('update "bolt_approvals"')) {
			const state: Schema.Json | undefined = request.parameters.find(
				(parameter) =>
					typeof parameter === 'object' &&
					parameter !== null &&
					!Array.isArray(parameter) &&
					Reflect.has(parameter, '_tag')
			);
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: state === undefined ? [] : [{ state }], affectedRows: 1 }
			});
		}
		if (request._tag === 'Query' && request.sql.includes('bolt_external_subjects')) {
			const externalId = request.parameters[1];
			const resolved =
				externalId === 'employee-external'
					? {
							user_id: employee.userId,
							tenant_id: employee.tenantId,
							email: null,
							team_id: 'team-employee-app'
						}
					: {
							user_id: subject.userId,
							tenant_id: subject.tenantId,
							email: null,
							team_id: 'team-admin'
						};
			return Promise.resolve({ _tag: 'Success', value: { rows: [resolved], affectedRows: 0 } });
		}
		if (
			request._tag === 'Query' &&
			request.sql.startsWith('select "id", "created_at"') &&
			request.sql.includes('from "employees"') &&
			request.parameters.includes('employee-1')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [{ id: 'employee-1', name: 'Grace', row_version: 2 }],
					affectedRows: 0
				}
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.includes('from "bolt_sync_outbox"') &&
			request.sql.includes('max(')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ xid: 3, sequence: 4 }], affectedRows: 0 }
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.includes('from "bolt_sync_outbox"') &&
			request.sql.includes('order by')
		) {
			const rows = [
				{
					cursor: { xid: 3, sequence: 5 },
					collection: 'employees',
					recordId: 'employee-1',
					operation: 'update',
					record: { name: 'Ada' }
				}
			];
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows,
					affectedRows: 0
				}
			});
		}
		if (request._tag === 'Query' && request.sql.includes('to_jsonb("record")')) {
			const record = { id: 'employee-1', name: 'Grace', row_version: 2 };
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [{ snapshot: record }],
					affectedRows: 0
				}
			});
		}
		if (request._tag === 'Query' && request.sql.includes('insert into "chat_message"')) {
			chatMessageId += 1;
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ id: `message-${chatMessageId}` }], affectedRows: 1 }
			});
		}
		if (request._tag === 'Query' && request.sql.includes('from "chat_session"')) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							conversation_id: 'conversation-1',
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
		if (
			request._tag === 'Query' &&
			request.sql.includes('from "chat_message"') &&
			request.sql.includes('"turn_id"')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							id: 'agent-turn-message',
							content: {
								id: 'invoke-agents.enqueue',
								status: 'queued',
								parent_agent_id: null,
								parts: [],
								subject,
								agent_name: 'web',
								usage_unreported: false
							}
						}
					],
					affectedRows: 0
				}
			});
		}
		if (
			request._tag === 'Transaction' &&
			request.statements.some((statement) => statement.sql.includes('__bolt_graph_record'))
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							__bolt_graph_ordinal: 0,
							__bolt_graph_collection: 'employees',
							__bolt_graph_id: 'employee-1',
							__bolt_graph_record: { id: 'employee-1', name: 'Grace', row_version: 2 }
						}
					],
					affectedRows: 1
				}
			});
		}
		return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 1 } });
	}
};
const ai: FacilityBinding<AIRequest, AIResponse> = {
	call: () =>
		Promise.resolve({ _tag: 'Success', value: { output: { text: 'Hello from the HR agent' } } })
};
const taskRequests: Array<TaskRequest> = [];
const tasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: (_metadata, request) => {
		taskRequests.push(request);
		return Promise.resolve({ _tag: 'Success', value: {} });
	}
};
const facilities: FacilityBindings = { scope, database, ai, tasks };

/**
 * The `user` row the session query above hands back, so it has to be a row the real query
 * could produce.
 *
 * Administration is identified by `user.status`, and that trusted status bypasses authored access
 * policy. `subjectFromRow` derives the subject from this row; request payload roles remain untrusted
 * and cannot add authority.
 *
 * The role ladder is left empty on purpose. `admin` and `impersonator` were compiler-injected and
 * are gone, and an empty array keeps the authority under test the status alone: nothing here can be
 * mistaken for a role match.
 */
const subject = {
	userId: 'admin-1',
	tenantId: 'tenant-1',
	status: 'admin',
	teamPath: ['admin'],
	policies: []
};
/**
 * Placed in `employee-app`, which is a team this workspace declares.
 *
 * The name has to match a key in the `teams` map above: a `teamPath` naming a team no release
 * declares resolves to no policies at all, and the subject then sees an empty app list — which
 * reads exactly like an authorization refusal and is not one.
 */
const employee = {
	userId: 'employee-1',
	tenantId: 'tenant-1',
	teamPath: ['employee-app'],
	policies: []
};

const invoke = async (command: string, input: Schema.Json): Promise<BundleResult> => {
	const invocation: Invocation = {
		_tag: 'Command',
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`invoke-${command}`),
		scope,
		deadlineEpochMs: Date.now() + 10_000,
		command,
		input,
		headers: { authorization: ['Bearer test-session'] }
	};
	return bundle.dispatch(invocation, facilities, new AbortController().signal);
};

// `null`, not `undefined`: passing `undefined` for a defaulted parameter re-applies the default, so
// the anonymous case would have silently run with a credential and every refusal below would pass.
/** `credential: null` is the unauthenticated `POST /_bolt/plugin/data-browser/query`. */
const invokePlugin = async (
	command: string,
	input: Schema.Json,
	trustedContext: unknown = {},
	credential: string | null = 'test-session'
): Promise<BundleResult> => {
	const invocation: Invocation = {
		_tag: 'Plugin',
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`plugin-${command}`),
		scope,
		deadlineEpochMs: Date.now() + 10_000,
		plugin: 'data-browser',
		command,
		input,
		headers: credential === null ? {} : { authorization: [`Bearer ${credential}`] },
		trustedContext: Schema.decodeUnknownSync(PluginTrustedContext)(trustedContext)
	};
	return bundle.dispatch(invocation, facilities, new AbortController().signal);
};

describe('runnable Bolt vertical slice', () => {
	it('impersonates within the tenant and exposes only target-visible apps', async () => {
		const result = await invoke('access.impersonate', { actor: subject, target: employee });
		expect(result).toMatchObject({
			_tag: 'Success',
			response: {
				value: { apps: ['hr'], subject: { userId: 'employee-1', impersonatedBy: 'admin-1' } }
			}
		});
	});

	it('derives command identity from credentials and ignores forged browser roles', async () => {
		// The payload tries to supply an employee subject. The trusted identity still comes from the
		// credential. The forged employee payload cannot narrow or replace the administrator.
		const forged = await invoke('apps.visible', { subject: employee });
		expect(forged).toMatchObject({
			_tag: 'Success',
			response: { value: { apps: ['hr', 'finance'] } }
		});
		const unauthenticated: Invocation = {
			_tag: 'Command',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('unauthenticated-command'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			command: 'apps.visible',
			input: { subject: employee },
			headers: {}
		};
		expect(
			await bundle.dispatch(unauthenticated, facilities, new AbortController().signal)
		).toMatchObject({ _tag: 'Failure', error: { code: 'unauthorized', httpStatus: 401 } });
	});

	it('preserves authorization refusal as a typed forbidden wire result', async () => {
		const result = await invoke('access.impersonate', {
			target: { ...employee, tenantId: 'other-tenant' }
		});
		expect(result).toMatchObject({
			_tag: 'Failure',
			error: { code: 'forbidden', httpStatus: 403 }
		});
		expect(Schema.decodeUnknownSync(BundleResult)(result)).toEqual(result);
	});

	it('normalizes Request credentials and binds authenticated identity to the invocation tenant', async () => {
		const request: Invocation = {
			_tag: 'Request',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('request-auth'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			method: 'GET',
			url: '/apps',
			headers: { Authorization: ['Bearer test-session'] }
		};
		expect(await bundle.dispatch(request, facilities, new AbortController().signal)).toMatchObject({
			_tag: 'Success',
			response: { value: { subject: { userId: 'admin-1' } } }
		});
		const foreign: Invocation = {
			...request,
			id: InvocationId.make('request-foreign'),
			scope: { ...scope, tenantId: TenantId.make('other-tenant') }
		};
		expect(await bundle.dispatch(foreign, facilities, new AbortController().signal)).toMatchObject({
			_tag: 'Failure',
			error: { code: 'forbidden', httpStatus: 403 }
		});
	});

	it('issues unpredictable sessions only for the authenticated subject', async () => {
		const first = await invoke('identity.startSession', {
			userId: 'forged-user',
			tenantId: 'other-tenant'
		});
		const second = await invoke('identity.startSession', {
			userId: 'forged-user',
			tenantId: 'other-tenant'
		});
		expect(first).toMatchObject({
			_tag: 'Success',
			response: { value: { credential: expect.stringMatching(/^bolt:tenant-1:/) } }
		});
		expect(second).toMatchObject({
			_tag: 'Success',
			response: { value: { credential: expect.stringMatching(/^bolt:tenant-1:/) } }
		});
		expect(first).not.toEqual(second);
	});

	it('runs approval request and decision with a durable resume task', async () => {
		const requested = await invoke('approvals.request', {
			subject,
			requestId: 'approval-1',
			operation: {
				collection: 'employees',
				approval: {
					id: 'employees:create',
					steps: [{ id: 'employees:create:stage:1', approvers: ['admin'] }],
					superceded_by: []
				}
			}
		});
		expect(requested).toMatchObject({ _tag: 'Success', response: { value: { _tag: 'Pending' } } });
		const decided = await invoke('approvals.decide', {
			subject,
			state: { _tag: 'Pending', requestId: 'approval-1', step: 0, operation: {} },
			decision: 'approve'
		});
		expect(decided, JSON.stringify(decided)).toMatchObject({
			_tag: 'Success',
			response: { value: { _tag: 'Approved', decidedBy: 'admin-1' } }
		});
	});

	it('reads the sync head and ordered diff through the database facility', async () => {
		expect(await invoke('sync.head', null)).toMatchObject({
			_tag: 'Success',
			response: { value: { xid: 3, sequence: 4 } }
		});
		const diff = await invoke('sync.diff', {
			subject,
			cursor: { xid: 3, sequence: 4 },
			limit: 100
		});
		expect(diff, JSON.stringify(diff)).toMatchObject({
			_tag: 'Success',
			response: { value: [{ recordId: 'employee-1' }] }
		});
	});

	it('atomically admits an agent message before executing the persisted turn', async () => {
		const admitted = await invoke('agents.enqueue', {
			subject,
			agent: 'web',
			conversationId: 'conversation-1',
			message: 'Hello'
		});
		expect(admitted, JSON.stringify(admitted)).toMatchObject({
			_tag: 'Success',
			response: { value: { status: 'queued', turnId: 'invoke-agents.enqueue' } }
		});
		const result = await invoke('agents.execute', {
			conversationId: 'conversation-1',
			turnId: 'invoke-agents.enqueue'
		});
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { output: { text: 'Hello from the HR agent' }, status: 'completed' } }
		});
	});

	it('refuses an unknown agent name and lists the declared workspace agent', async () => {
		expect(await invoke('workspace.agents', null)).toMatchObject({
			_tag: 'Success',
			response: { value: ['web'] }
		});
		expect(
			await invoke('agents.enqueue', {
				subject,
				agent: 'workspace',
				conversationId: 'conversation-missing',
				message: 'Hello'
			})
		).toMatchObject({
			_tag: 'Failure',
			error: { code: 'forbidden', httpStatus: 403 }
		});
	});

	it('dispatches an authored remote through the authenticated runtime registry', async () => {
		expect(
			await invoke('invoke.echo', { input: { message: 'hello' }, subject: employee })
		).toMatchObject({
			_tag: 'Success',
			response: { value: { input: { message: 'hello' }, source: 'authored-remote' } }
		});
	});

	it('exposes a read-only Data Browser plugin through the same collection policy path', async () => {
		const result = await invokePlugin('query', { collection: 'employees', input: { limit: 20 } });
		expect(result).toMatchObject({ _tag: 'Success', response: { value: [] } });
	});

	/**
	 * These three assertions used to read the other way round: the plugin minted a subject out of
	 * `trustedContext.roles`, so `{ teamPath: ['admin'], policies: [] }` on an unauthenticated POST was an admin. The
	 * roles now come from the session the credential names, which makes the payload's copy inert — and
	 * with no credential at all there is nothing to run as, so the read is refused rather than answered
	 * with the empty page an inert role set would have produced.
	 */
	it('refuses a Data Browser query whose only claim to admin is its own trustedContext', async () => {
		const forged = await invokePlugin(
			'query',
			{ collection: 'employees', input: { limit: 20 } },
			{ teamPath: ['admin'], policies: [], subject: 'admin-external' },
			null
		);
		expect(forged).toMatchObject({
			_tag: 'Failure',
			error: { code: 'forbidden', httpStatus: 403 }
		});
		const bare = await invokePlugin('query', { collection: 'employees' }, {}, null);
		expect(bare).toMatchObject({ _tag: 'Failure', error: { code: 'forbidden', httpStatus: 403 } });
	});

	it('ignores the roles a trustedContext claims and uses the ones its credential resolves', async () => {
		const claimed = await invokePlugin(
			'query',
			{ collection: 'employees' },
			{ teamPath: ['forged-role'], policies: [] }
		);
		expect(claimed).toMatchObject({ _tag: 'Success', response: { value: [] } });
	});

	it('never mixes actor roles with an impersonated target', async () => {
		const impersonated = await invokePlugin(
			'query',
			{ collection: 'employees' },
			{ impersonatedSubject: 'employee-external' }
		);
		expect(impersonated).toMatchObject({
			_tag: 'Failure',
			error: { code: 'forbidden', httpStatus: 403 }
		});
	});

	it('dispatches the declarative mutation command emitted by the browser collection proxy', async () => {
		const mutation = await invoke('collections.mutate', {
			subject,
			collection: 'employees',
			values: { id: 'employee-1', name: 'Grace' }
		});
		expect(mutation, JSON.stringify(mutation)).toMatchObject({
			_tag: 'Success',
			response: { value: { records: [{ id: 'employee-1', name: 'Grace', row_version: 2 }] } }
		});
	});

	it('returns bounded realtime frames and explicit close outcomes', async () => {
		const input: Invocation = {
			_tag: 'Realtime',
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('realtime-input'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			connectionId: 'connection-1',
			event: {
				_tag: 'Input',
				frame: { sequence: 7, kind: 'text', bytes: new TextEncoder().encode('hello') }
			}
		};
		const result = await bundle.dispatch(input, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { realtime: { nextCursor: '7', frames: [{ cursor: '7', kind: 'text' }] } }
		});
	});

	it('registers every durable callback during activation', async () => {
		taskRequests.length = 0;
		const activation: Activation = {
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('activation-1'),
			scope,
			deadlineEpochMs: Date.now() + 10_000,
			reason: 'deploy'
		};
		const result = await bundle.activate(activation, facilities, new AbortController().signal);
		expect(result).toEqual({
			_tag: 'Activated',
			// Routing, and only routing. A registration used to carry `schedule` and `input` as well, so
			// that a host could *originate* work — and that was the wrong side of the seam, because a
			// cron is declared by a release and only the guest can read a release. Schedules are now
			// rows in the tenant's own `bolt_schedule`, and what a host is told is one number.
			registrations: [
				{ command: 'agents.continue' },
				{ command: 'agents.execute' },
				// A refused approval has cleanup to do — the provisional row it locked. Routed beside
				// `resume` because a rejection is followed up as deliberately as an approval is.
				{ command: 'collections.discard' },
				{ command: 'collections.resume' },
				{ command: 'envoys.complete' },
				{ command: 'envoys.receive' },
				{ command: 'integrations.flush' },
				{ command: 'integrations.pull' },
				{ command: 'notifications.drain' },
				// The tick, which is the only command a host's timer ever sends.
				{ command: 'tasks.tick' }
			],
			// This workspace declares no schedule and has nothing queued, so there is no instant to arm
			// a timer to — which is the state an idle workspace spends almost all of its life in, and it
			// has to cost nothing rather than a heartbeat.
			nextDueAtEpochMs: null
		});
		expect(taskRequests.filter((request) => request._tag === 'Register')).toHaveLength(10);
	});
});
