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
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { EnvironmentName, InvocationId, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { app, agent, collection, field, policy, workspace } from '../../src/authoring/index.js';
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
			roles: ['employee'],
			apps: ['hr']
		}),
		policy({
			name: 'admin-approval',
			effect: 'allow',
			actions: ['approve'],
			roles: ['admin'],
			apps: ['approvals']
		}),
		policy({
			name: 'admin-sync',
			effect: 'allow',
			actions: ['sync'],
			roles: ['admin'],
			apps: ['*']
		}),
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
	agents: [agent({ name: 'helper', prompt: 'Help the HR team.', tools: [], skills: [] })],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: ['database', 'ai', 'tasks']
});
const manifest = buildManifest(definition, { artifactId: 'hr-fixture' });
const bundle = makeBundle(definition, manifest, {
	echo: (input) => Promise.resolve({ input, source: 'authored-remote' })
});

const database: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
	call: (_metadata, request) => {
		// Authentication reads Better Auth's session joined to its user table. Matching on
		// `bolt_auth_session` keeps this stub answering the query identity actually makes; matching
		// the old `bolt_sessions` would have it answer nothing and every command would read as
		// unauthenticated.
		if (request._tag === 'Query' && request.sql.includes('bolt_auth_session')) {
			return Promise.resolve({ _tag: 'Success', value: { rows: [subject], affectedRows: 0 } });
		}
		// `startSession` admits the subject before minting, and refuses when no row comes back.
		if (request._tag === 'Query' && request.sql.includes('update bolt_auth_user')) {
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ id: subject.userId }], affectedRows: 1 }
			});
		}
		if (request._tag === 'Query' && request.sql.includes('bolt_external_subjects')) {
			const externalId = request.parameters[1];
			const resolved = externalId === 'employee-external' ? employee : subject;
			return Promise.resolve({ _tag: 'Success', value: { rows: [resolved], affectedRows: 0 } });
		}
		if (request._tag === 'Query' && request.sql.includes('max(xid)')) {
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ xid: 3, sequence: 4 }], affectedRows: 0 }
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.includes('bolt_sync_outbox') &&
			request.sql.includes('order by o.xid')
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							cursor: { xid: 3, sequence: 5 },
							collection: 'employees',
							recordId: 'employee-1',
							operation: 'update',
							record: { name: 'Ada' }
						}
					],
					affectedRows: 0
				}
			});
		}
		if (request._tag === 'Query' && request.sql.includes('select state from bolt_approvals')) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [{ state: { _tag: 'Pending', requestId: 'approval-1', step: 0, operation: {} } }],
					affectedRows: 0
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
		return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } });
	}
};
const facilities: FacilityBindings = { scope, database, ai, tasks };

const subject = {
	userId: 'admin-1',
	tenantId: 'tenant-1',
	roles: ['admin', 'impersonator'],
	teams: []
};
const employee = { userId: 'employee-1', tenantId: 'tenant-1', roles: ['employee'], teams: [] };

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
	trustedContext: Schema.Json = {},
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
		trustedContext
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
		const forged = await invoke('apps.visible', { subject: employee });
		expect(forged).toMatchObject({ _tag: 'Success', response: { value: { apps: [] } } });
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
			operation: { collection: 'employees' }
		});
		expect(requested).toMatchObject({ _tag: 'Success', response: { value: { _tag: 'Pending' } } });
		const decided = await invoke('approvals.decide', {
			subject,
			state: { _tag: 'Pending', requestId: 'approval-1', step: 0, operation: {} },
			decision: 'approve'
		});
		expect(decided).toMatchObject({
			_tag: 'Success',
			response: { value: { _tag: 'Approved', decidedBy: 'admin-1' } }
		});
	});

	it('reads the sync head and ordered diff through the database facility', async () => {
		expect(await invoke('sync.head', null)).toMatchObject({
			_tag: 'Success',
			response: { value: { xid: 3, sequence: 4 } }
		});
		expect(
			await invoke('sync.diff', { subject, cursor: { xid: 3, sequence: 4 }, limit: 100 })
		).toMatchObject({ _tag: 'Success', response: { value: [{ recordId: 'employee-1' }] } });
	});

	it('communicates with an agent and persists the turn before scheduling continuation', async () => {
		const result = await invoke('agents.turn', {
			subject,
			agent: 'helper',
			conversationId: 'conversation-1',
			message: 'Hello'
		});
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { output: { text: 'Hello from the HR agent' }, status: 'completed' } }
		});
	});

	it('refuses an unknown agent name and lists the declared workspace agent', async () => {
		expect(await invoke('workspace.agents', null)).toMatchObject({
			_tag: 'Success',
			response: { value: ['helper'] }
		});
		expect(
			await invoke('agents.turn', {
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
	 * `trustedContext.roles`, so `{ roles: ['admin'] }` on an unauthenticated POST was an admin. The
	 * roles now come from the session the credential names, which makes the payload's copy inert — and
	 * with no credential at all there is nothing to run as, so the read is refused rather than answered
	 * with the empty page an inert role set would have produced.
	 */
	it('refuses a Data Browser query whose only claim to admin is its own trustedContext', async () => {
		const forged = await invokePlugin(
			'query',
			{ collection: 'employees', input: { limit: 20 } },
			{ roles: ['admin'], subject: 'admin-external' },
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
			{ roles: ['forged-role'] }
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

	it('dispatches update and delete commands emitted by the browser collection proxy', async () => {
		expect(
			await invoke('collections.update', {
				subject,
				collection: 'employees',
				id: 'employee-1',
				values: { name: 'Grace' }
			})
		).toMatchObject({ _tag: 'Success', response: { value: { updated: true } } });
		expect(
			await invoke('collections.delete', { subject, collection: 'employees', id: 'employee-1' })
		).toMatchObject({ _tag: 'Success', response: { value: { deleted: true } } });
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
			registrations: [
				{ command: 'agents.resume', schedule: null, input: null },
				{ command: 'channels.receive', schedule: null, input: null },
				// A refused approval has cleanup to do — the provisional row it locked. Routed beside
				// `resume` because a rejection is followed up as deliberately as an approval is.
				{ command: 'collections.discard', schedule: null, input: null },
				{ command: 'collections.resume', schedule: null, input: null },
				// Routing only. `integrations.flush` is the outbound drain, and a workspace that declares
				// no send binding gets the route without a cron: nothing here has an outbox to empty.
				{ command: 'integrations.flush', schedule: null, input: null },
				{ command: 'integrations.pull', schedule: null, input: null },
				{ command: 'notifications.drain', schedule: null, input: null }
			]
		});
		expect(taskRequests.filter((request) => request._tag === 'Register')).toHaveLength(7);
	});
});
