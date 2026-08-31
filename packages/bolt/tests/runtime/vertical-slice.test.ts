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
	requiredFacilities: ['database', 'ai', 'tasks'],
	schemaFingerprint: 'sha256:vertical-slice-fixture'
});
const manifest = buildManifest(definition, { artifactId: 'hr-fixture' });
const bundle = makeBundle(definition, manifest, {
	echo: (input) => Promise.resolve({ input, source: 'authored-remote' })
});

const employeeRecordId = '00000000-0000-5000-8000-000000000001';
let chatMessageId = 0;
let browserMutationApplied = false;
type BrowserMutationLedgerRow = Readonly<{
	request_digest: Schema.Json;
	status: 'running' | 'terminal';
	outcome: Schema.Json | null;
}>;
const browserMutationLedger = new Map<string, BrowserMutationLedgerRow>();
const browserMutationLedgerKey = (parameters: ReadonlyArray<Schema.Json>): string =>
	JSON.stringify(parameters.slice(0, 6));
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
			request.sql.startsWith('select request_digest, status, outcome') &&
			request.sql.includes('from bolt_browser_mutation')
		) {
			const row = browserMutationLedger.get(browserMutationLedgerKey(request.parameters));
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows:
						row === undefined
							? []
							: [
									{
										...row,
										...(request.sql.includes('retry_after_seconds')
											? { retry_after_seconds: 30 }
											: {})
									}
								],
					affectedRows: 0
				}
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.startsWith('with cleaned as') &&
			request.sql.includes('insert into bolt_browser_mutation')
		) {
			const key = browserMutationLedgerKey(request.parameters);
			if (browserMutationLedger.has(key))
				return Promise.resolve({
					_tag: 'Success',
					value: { rows: [], affectedRows: 0 }
				});
			browserMutationLedger.set(key, {
				// Claim parameters are the six-part scope, partition key ($7), schema fingerprint ($8),
				// then the request digest ($9).
				request_digest: request.parameters[8] ?? null,
				status: 'running',
				outcome: null
			});
			return Promise.resolve({
				_tag: 'Success',
				value: { rows: [{ id: 'browser-mutation-1' }], affectedRows: 1 }
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.includes('__bolt_write_wave_record') &&
			request.parameters.includes(employeeRecordId)
		) {
			const record = browserMutationApplied
				? { id: employeeRecordId, name: 'Grace', row_version: 2 }
				: { id: employeeRecordId, name: 'Ada', row_version: 1 };
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							__bolt_write_wave_kind: 'row',
							__bolt_write_wave_ordinal: 0,
							__bolt_write_wave_record: record
						}
					],
					affectedRows: 0
				}
			});
		}
		if (
			request._tag === 'Query' &&
			request.sql.includes('from "employees"') &&
			!request.sql.includes('to_jsonb') &&
			request.parameters.includes(employeeRecordId)
		) {
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						browserMutationApplied
							? { id: employeeRecordId, name: 'Grace', row_version: 2 }
							: { id: employeeRecordId, name: 'Ada', row_version: 1 }
					],
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
					recordId: employeeRecordId,
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
			const record = { id: employeeRecordId, name: 'Ada', row_version: 1 };
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
			request._tag === 'Transaction' &&
			request.statements.some((statement) => statement.sql.includes('__bolt_graph_record'))
		) {
			browserMutationApplied = true;
			const completion = request.statements.find((statement) =>
				statement.sql.includes("update bolt_browser_mutation set status = 'terminal'")
			);
			if (completion !== undefined) {
				const key = browserMutationLedgerKey(completion.parameters);
				const claimed = browserMutationLedger.get(key);
				if (
					claimed !== undefined &&
					claimed.status === 'running' &&
					claimed.request_digest === completion.parameters[6]
				) {
					browserMutationLedger.set(key, {
						request_digest: claimed.request_digest,
						status: 'terminal',
						outcome: completion.parameters[7] ?? null
					});
				}
			}
			return Promise.resolve({
				_tag: 'Success',
				value: {
					rows: [
						{
							__bolt_graph_ordinal: 0,
							__bolt_graph_collection: 'employees',
							__bolt_graph_id: employeeRecordId,
							__bolt_graph_record: { id: employeeRecordId, name: 'Grace', row_version: 2 }
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
	call: (_metadata, request) =>
		Promise.resolve({
			_tag: 'Success',
			value: {
				output:
					request._tag === 'Models'
						? // The model catalog the runtime decodes before every turn: one default, one option.
							{ defaultModel: 'gpt-test', options: [{ id: 'gpt-test', contextLength: 8192 }] }
						: { text: 'Hello from the HR agent' }
			}
		})
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

	it('refuses an unknown agent name', async () => {
		expect(
			await invoke('agents.enqueue', {
				subject,
				agent: 'workspace',
				conversationId: 'conversation-missing',
				turnId: 'turn-missing',
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
	 * The plugin never mints a subject out of `trustedContext.roles`: `{ teamPath: ['admin'], policies: [] }` on an
	 * unauthenticated POST is not an admin. The roles come from the session the credential names, which makes the
	 * payload's copy inert — and with no credential at all there is nothing to run as, so the read is refused rather
	 * than answered with the empty page an inert role set would have produced.
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
		// This facility is module-scoped, unlike a real per-test database. Do not let an interrupted or
		// repeated invocation inherit a claimed key from an earlier execution in the same worker.
		browserMutationLedger.clear();
		browserMutationApplied = false;
		const mutation = await invoke('collections.mutate', {
			protocolVersion: 2,
			idempotencyKey: 'vertical-slice-update-employee',
			issuedAtEpochMs: Date.now(),
			partitionKey: 'sha256:vertical-slice-partition',
			schemaFingerprint: 'sha256:vertical-slice-fixture',
			graph: {
				action: 'update',
				collection: 'employees',
				values: { id: employeeRecordId, name: 'Grace' }
			},
			baseVersions: [
				{ row: { collection: 'employees', recordId: employeeRecordId }, rowVersion: 1 }
			]
		});
		expect(mutation, JSON.stringify(mutation)).toMatchObject({
			_tag: 'Success',
			response: {
				value: {
					resolution: 'accepted',
					mutationId: 'vertical-slice-update-employee',
					schemaFingerprint: 'sha256:vertical-slice-fixture',
					records: [{ id: employeeRecordId, name: 'Grace', row_version: 2 }],
					changes: [{ collection: 'employees', recordId: employeeRecordId }]
				}
			}
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
			// Routing, and only routing. A registration carries the command alone: a cron is declared
			// by a release and only the guest can read a release, so a host is never told anything
			// that would let it originate work. Schedules are rows in the tenant's own `bolt_schedule`,
			// and what a host is told is one number.
			registrations: [
				// A refused approval has durable hold and browser-ledger cleanup to do. Routed beside
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
		expect(taskRequests.filter((request) => request._tag === 'Register')).toHaveLength(8);
	});
});
