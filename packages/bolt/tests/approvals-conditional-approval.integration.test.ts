import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy, noApproval } from '../src/authoring/approval-flow.js';
import {
	approvalConfigurationId,
	describePolicy,
	policyRuntimeFunctionsFor,
	type PolicyRuntimeFunction
} from '../src/authoring/policy-introspection.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';
import { field } from '../src/authoring/workspace-schema.js';

const writer = {
	userId: '00000000-0000-4000-8000-000000000221',
	tenantId: 'test-tenant',
	teamPath: ['writers'],
	policies: []
};

const declaration = (flow: PolicyRuntimeFunction, authorize?: PolicyRuntimeFunction) => ({
	description: 'Writers create normalized entries; selected entries require review.',
	grants: {
		entries: {
			read: {},
			mutate: {
				new: {
					...(authorize === undefined ? {} : { authorize }),
					approval: { flow, superceded_by: ['Review Leads'] }
				}
			}
		}
	}
});

const describedPolicy = (flow: PolicyRuntimeFunction, authorize?: PolicyRuntimeFunction) =>
	describePolicy('entry_writer', declaration(flow, authorize));

const definitionFor = (policy: ReturnType<typeof describedPolicy>) =>
	testWorkspace({
		collections: [
			{
				name: 'entries',
				fields: {
					label: field.string({ required: true }),
					normalized: field.string({ required: true })
				}
			}
		],
		policies: [policy],
		teams: { writers: ['entry_writer'], Reviewers: [], 'Review Leads': [] }
	});

/** The transform derives `normalized`; policy code is asked of the payload the engine will write. */
const authoredFor = (
	policy: ReturnType<typeof describedPolicy>,
	functions = policyRuntimeFunctionsFor([policy])
): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	collections: {
		entries: {
			create: { input: { columns: { label: true } } },
			transform: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
				Effect.succeed(
					inputs.map((input) => ({
						...input,
						normalized: String(input['label']).trim().toLocaleLowerCase()
					}))
				)
		}
	}
});

const create = (runtime: BoltTestRuntime, effectId: string, labels: ReadonlyArray<string>) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).write(EffectId.make(effectId), writer, [
				{ collection: 'entries', action: 'create', inputs: labels.map((label) => ({ label })) }
			]);
		})
	);

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(cause: unknown) => unwrapMutationPhase(cause)
	);

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('routed policy approvals', () => {
	it('serializes only derived live-code markers and superseding teams', () => {
		const policy = describedPolicy(() => approveBy('Reviewers'));
		const id = approvalConfigurationId('entry_writer', 'entries', 'create');
		const serialized = JSON.stringify(policy);

		expect(policy.grants?.[1]?.approval).toEqual({
			id,
			flow: true,
			superceded_by: ['Review Leads']
		});
		expect(serialized).not.toContain('Reviewers');
		expect(policyRuntimeFunctionsFor([policy]).approvalFlows[id]).toEqual(expect.any(Function));
	});

	it('uses Effect and plain TypeScript over the transformed payload and a read-only api', async () => {
		const seen: Array<unknown> = [];
		const exposedWrites: Array<boolean> = [];
		const policy = describedPolicy((context, api) =>
			Effect.gen(function* () {
				const entries = (
					api as {
						readonly db: {
							readonly entries: {
								readonly findMany: () => Effect.Effect<ReadonlyArray<unknown>>;
							};
						};
					}
				).db.entries;
				exposedWrites.push('mutate' in entries);
				yield* entries.findMany();
				const normalized = Reflect.get(
					Reflect.get(context as object, 'record') as object,
					'normalized'
				);
				seen.push(normalized);
				return normalized === 'review' ? approveBy('Reviewers') : noApproval;
			})
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });

		const committed = await create(harness, 'approval-none', [' Ordinary ']);
		expect(committed.records).toHaveLength(1);
		expect(committed.records[0]).toMatchObject({ normalized: 'ordinary' });
		expect(committed.pendingApproval).toBeUndefined();
		const reviewed = await create(harness, 'approval-review', [' REVIEW ']);
		expect(reviewed.pendingApproval?.requestId).toBeTypeOf('string');
		expect(seen).toEqual(['ordinary', 'review']);
		expect(exposedWrites).toEqual([false, false]);
	});

	it('holds the whole batch under the one route its gated root resolves', async () => {
		const policy = describedPolicy((context) =>
			Reflect.get(Reflect.get(context as object, 'record') as object, 'normalized') === 'review'
				? approveBy('Reviewers')
				: noApproval
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });

		const result = await create(harness, 'approval-mixed-roots', [' Ordinary ', ' REVIEW ']);
		const requestId = result.pendingApproval?.requestId;
		expect(requestId).toBeTypeOf('string');
		expect(result.records.map((record) => record['normalized'])).toEqual(['ordinary', 'review']);
		// One batch, one route: both rows are committed provisionally under the same hold.
		expect(
			await harness.database.query(
				'select normalized, approval_id from entries order by normalized'
			)
		).toEqual([
			{ normalized: 'ordinary', approval_id: requestId },
			{ normalized: 'review', approval_id: requestId }
		]);
		expect(await harness.database.query('select record_id, status from approval_request')).toEqual([
			{ record_id: result.records[1]?.['id'], status: 'ONGOING' }
		]);
	});

	it('runs write authorization against the same prepared object and accepts only true', async () => {
		const policy = describedPolicy(
			() => noApproval,
			(context) =>
				Reflect.get(Reflect.get(context as object, 'record') as object, 'normalized') === 'allowed'
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });

		const allowed = await create(harness, 'authorization-allow', [' ALLOWED ']);
		expect(allowed.records).toHaveLength(1);
		expect(await failureOf(create(harness, 'authorization-deny', [' denied ']))).toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied'
		});
	});

	it.each([
		['missing live flow', (() => noApproval) as PolicyRuntimeFunction, 'missing'],
		[
			'a thrown flow',
			(() => {
				throw new Error('routing broke');
			}) as PolicyRuntimeFunction,
			'present'
		],
		['an unbranded object', (() => ({ _tag: 'NoApproval' })) as PolicyRuntimeFunction, 'present']
	])('fails closed for %s', async (_label, flow, runtime) => {
		const policy = describedPolicy(flow);
		const functions = policyRuntimeFunctionsFor([policy]);
		// The serialized declaration deliberately has no WeakMap-attached closure. This is the exact
		// broken tenant-runtime boundary the missing-live-flow case must refuse.
		const runtimePolicy =
			runtime === 'missing'
				? (JSON.parse(JSON.stringify(policy)) as ReturnType<typeof describedPolicy>)
				: policy;
		harness = await makeBoltTestRuntime(definitionFor(runtimePolicy), {
			authored: authoredFor(
				policy,
				runtime === 'missing' ? { authorizations: {}, approvalFlows: {} } : functions
			)
		});

		expect(await failureOf(create(harness, `flow-failure:${_label}`, ['ordinary']))).toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied'
		});
		expect(await harness.database.query('select id from entries')).toEqual([]);
	});
});
