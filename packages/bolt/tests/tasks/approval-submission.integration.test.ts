import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { approveBy } from '../../src/authoring/approval-flow.js';
import { automation } from '../../src/authoring/automations-schema.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import * as Automations from '../../src/runtime/automations/automations.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import {
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	TEST_TENANT,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

const reviewedWriter = describePolicy('reviewed_writer', {
	description: 'Creates one record only after the Reviewers team approves it.',
	grants: {
		records: {
			read: {},
			create: {
				fields: ['title'],
				approval: { flow: () => approveBy('Reviewers'), superceded_by: [] }
			}
		}
	}
});

const definition = workspace({
	name: 'approval-task-submission',
	version: '1',
	collections: [
		collection({ name: 'records', fields: { title: field.string({ required: true }) } })
	],
	apps: [],
	policies: [reviewedWriter],
	teams: { Reviewers: [] },
	automations: [
		automation({
			name: 'reviewed_write',
			trigger: { _tag: 'Manual' },
			command: 'automations.reviewed_write',
			policies: ['reviewed_writer']
		})
	],
	integrations: [],
	prompt: 'Exercise durable approval submission.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database', 'tasks'],
	mutationCompatibility: {
		offlineHorizonMillis: 14 * 24 * 60 * 60 * 1_000,
		currentSchemaFingerprint: 'sha256:approval-submission-fixture',
		adapters: []
	}
});

const policyFunctions = policyRuntimeFunctionsFor([reviewedWriter]);
const authored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: policyFunctions.authorizations,
	approvalFlows: policyFunctions.approvalFlows,
	automations: {
		reviewed_write: {
			name: 'reviewed_write',
			trigger: { _tag: 'Manual' as const },
			policies: ['reviewed_writer'],
			handler: (api: unknown) => {
				if (typeof api !== 'object' || api === null)
					throw new Error('automation api is unavailable');
				const database = Reflect.get(api, 'db');
				if (typeof database !== 'object' || database === null)
					throw new Error('automation database is unavailable');
				const records = Reflect.get(database, 'records');
				if (typeof records !== 'object' || records === null)
					throw new Error('records collection is unavailable');
				const mutate = Reflect.get(records, 'mutate');
				if (typeof mutate !== 'function') throw new Error('records.mutate is unavailable');
				return mutate({ title: 'Held for review' });
			}
		}
	}
};

const scope = {
	tenantId: TenantId.make(TEST_TENANT),
	environment: EnvironmentName.make(TEST_ENVIRONMENT),
	releaseId: ReleaseId.make('approval-task-release')
};

describe('approval-gated automation task submission', () => {
	let harness: BoltTestRuntime | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it('finishes the automation as awaiting approval without retrying or committing its write', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const active = harness;
		const taskId = await active.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Automations.Service).start(
					active.effectId('manual-reviewed-write'),
					'reviewed_write',
					{}
				);
			})
		);
		const bundle = makeBundle(
			definition,
			buildManifest(definition, { artifactId: 'approval-task-submission' }),
			{},
			{},
			authored
		);
		const facilities: FacilityBindings = {
			scope,
			database: active.database.binding,
			tasks: active.tasks.binding
		};
		const tick = Invocation.cases.Task.make({
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make('approval-task-tick'),
			scope,
			deadlineEpochMs: Date.now() + 30_000,
			command: 'tasks.tick',
			input: {},
			attempt: 0
		});

		const result = await bundle.dispatch(tick, facilities, new AbortController().signal);
		expect(result).toMatchObject({
			_tag: 'Success',
			response: { value: { ran: 1, rolled: 0, declined: false } }
		});
		expect(
			await active.database.query(
				'select status, attempts, result, error from bolt_task where effect_id = $1',
				[taskId]
			)
		).toEqual([
			{
				status: 'done',
				attempts: 1,
				result: {
					status: 'awaiting_approval',
					pending: true,
					requestId: expect.any(String),
					collection: 'records',
					id: expect.any(String),
					action: 'create'
				},
				error: null
			}
		]);
		expect(await active.database.query('select id from records')).toEqual([]);
		expect(
			await active.database.query("select state ->> '_tag' as state from bolt_approvals")
		).toEqual([{ state: 'Pending' }]);
	});
});
