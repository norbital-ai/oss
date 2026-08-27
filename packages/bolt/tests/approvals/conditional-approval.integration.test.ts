import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy, noApproval } from '../../src/authoring/approval-flow.js';
import {
	approvalConfigurationId,
	describePolicy,
	policyRuntimeFunctionsFor,
	type PolicyRuntimeFunction
} from '../../src/authoring/policy-introspection.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import {
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { field } from '../../src/authoring/workspace-schema.js';

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
			create: {
				...(authorize === undefined ? {} : { authorize }),
				approval: { flow, superceded_by: ['Review Leads'] }
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

const authoredFor = (
	policy: ReturnType<typeof describedPolicy>,
	functions = policyRuntimeFunctionsFor([policy])
): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	hooks: {
		entries: {
			create: {
				perRecord: {
					before: {
						description: 'Normalizes the candidate before policy code runs.',
						handler: (context: unknown) => {
							const input = (context as { readonly input: Readonly<Record<string, unknown>> })
								.input;
							return {
								...input,
								normalized: String(input['label']).trim().toLocaleLowerCase()
							};
						}
					}
				}
			}
		}
	}
});

const mutate = (runtime: BoltTestRuntime, effectId: string, label: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).mutate(
				EffectId.make(effectId),
				writer,
				'entries',
				[{ label }],
				false,
				0,
				{ declarative: true }
			);
		})
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

	it('uses Effect and plain TypeScript over the post-hook candidate and a read-only api', async () => {
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

		await expect(mutate(harness, 'approval-none', ' Ordinary ')).resolves.toEqual([
			expect.objectContaining({ normalized: 'ordinary' })
		]);
		await expect(mutate(harness, 'approval-review', ' REVIEW ')).rejects.toBeInstanceOf(
			Collections.PendingApproval
		);
		expect(seen).toEqual(['ordinary', 'review']);
		expect(exposedWrites).toEqual([false, false]);
	});

	it('runs write authorization against the same prepared object and accepts only true', async () => {
		const policy = describedPolicy(
			() => noApproval,
			(context) =>
				Reflect.get(Reflect.get(context as object, 'record') as object, 'normalized') === 'allowed'
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });

		await expect(mutate(harness, 'authorization-allow', ' ALLOWED ')).resolves.toHaveLength(1);
		await expect(mutate(harness, 'authorization-deny', ' denied ')).rejects.toMatchObject({
			_tag: 'Bolt.Collections.MutationPhaseFailure',
			cause: { _tag: 'Bolt.AccessControl.AccessDenied' }
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

		await expect(mutate(harness, `flow-failure:${_label}`, 'ordinary')).rejects.toMatchObject({
			_tag: 'Bolt.Collections.MutationPhaseFailure',
			cause: { _tag: 'Bolt.AccessControl.AccessDenied' }
		});
		expect(await harness.database.query('select id from entries')).toEqual([]);
	});
});
