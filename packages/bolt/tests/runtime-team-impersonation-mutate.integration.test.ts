import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CollectionMutationIdempotencyKey,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import * as AccessControl from '../src/runtime/access/access-control.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { ADMIN_STATUS } from '../src/runtime/identity/identity.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as Workspace from '../src/runtime/workspace.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { seedSession, seedTeam } from './support/fixture-identity.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const command = (name: string, credential: string, input: unknown = {}, team?: string) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${credential}-${team ?? 'self'}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: {
			authorization: [`Bearer ${credential}`],
			...(team === undefined ? {} : { 'x-colony-impersonated-team': [team] })
		}
	});

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const schemaFingerprint = async (runtime: BoltTestRuntime): Promise<string> => {
	const workspace = await runtime.runtime.runPromise(Workspace.Service);
	const fingerprint = workspace.definition.schemaFingerprint;
	if (typeof fingerprint !== 'string')
		throw new TypeError('The test runtime provisioned no schema fingerprint.');
	return fingerprint;
};

const hrControllerPolicy = describePolicy('hr_controller', {
	description: 'HR controller with approval-gated leave create.',
	capabilities: { apps: ['hr_controller'] },
	grants: {
		leave_requests: {
			read: {},
			mutate: {
				new: {
					approval: { flow: () => approveBy('HR Manager'), superceded_by: [] }
				}
			}
		}
	}
});

const impersonationWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'leave_requests',
			fields: {
				employment_id: field.uuid({ required: true }),
				note: field.string({ required: false })
			}
		})
	],
	apps: [],
	policies: [hrControllerPolicy],
	teams: {
		'HQ Payroll HR': ['hr_controller'],
		'HR Manager': []
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const policyFunctions = policyRuntimeFunctionsFor([hrControllerPolicy]);
const authored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: policyFunctions.authorizations,
	approvalFlows: policyFunctions.approvalFlows
};

describe('team impersonation mutate', () => {
	it('allows approval-gated leave create for a previewed HQ Payroll HR subject', async () => {
		harness = await makeBoltTestRuntime(impersonationWorkspace, { authored });
		await seedTeam(harness, 'HQ Payroll HR');
		await seedTeam(harness, 'HR Manager');
		await seedSession(harness, {
			token: 'admin-token',
			user: 'user-admin-token',
			status: ADMIN_STATUS
		});

		const explained = await harness.runtime.runPromise(
			dispatchInvocation(
				command(
					'access.explain',
					'admin-token',
					{ action: 'create', resource: 'leave_requests' },
					'HQ Payroll HR'
				)
			)
		);
		expect(explained.value).toMatchObject({ allowed: true });

		const fingerprint = await schemaFingerprint(harness);
		const created = await harness.runtime.runPromise(
			dispatchInvocation(
				command(
					'collections.mutate',
					'admin-token',
					{
						protocolVersion: 2,
						idempotencyKey: CollectionMutationIdempotencyKey.make('leave-preview-create'),
						issuedAtEpochMs: Date.now(),
						partitionKey: 'sha256:impersonation-mutate-partition',
						schemaFingerprint: fingerprint,
						graph: {
							action: 'mutate',
							collection: 'leave_requests',
							rows: [
								{
									action: 'create',
									values: { id: rid('leave-1'), employment_id: rid('employment-1'), note: 'Annual' }
								}
							]
						},
						baseVersions: []
					},
					'HQ Payroll HR'
				)
			)
		);
		expect(created.value).toMatchObject({
			resolution: 'accepted',
			pendingApproval: {
				collection: 'leave_requests',
				action: 'create'
			}
		});
	});
});
