import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy, noApproval } from '../src/authoring/approval-flow.js';
import { authoredHooks, type CollectionHooks } from '../src/authoring/contracts-schema.js';
import {
	approvalConfigurationId,
	describePolicy,
	policyRuntimeFunctionsFor,
	type PolicyRuntimeFunction
} from '../src/authoring/policy-introspection.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../src/runtime/collections/authored.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
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

/**
 * The fixture collection as a schema, so the hooks below are typed the way a compiled workspace's
 * are: `CollectionHooks` reads handler contexts off `tables`, making `input`, `existing` and
 * `api.db.entries` inferred rather than reflected.
 *
 * `normalized` is optional in the insert because the hook derives it — the honest statement of
 * what a create must carry.
 */
interface EntriesSchema {
	readonly tables: {
		readonly entries: {
			readonly $inferSelect: {
				readonly id: string;
				readonly label: string;
				readonly normalized: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly label: string;
				readonly normalized?: string;
			};
		};
	};
	readonly relations: Record<string, never>;
}

const entriesHooks: CollectionHooks<EntriesSchema, 'entries'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'Normalizes the candidate before policy code runs.',
				handler: (context) => {
					const { input } = context;
					if (context.existing !== undefined) return input;
					return {
						...input,
						normalized: String(input['label']).trim().toLocaleLowerCase()
					};
				}
			}
		}
	}
};

const authoredFor = (
	policy: ReturnType<typeof describedPolicy>,
	functions = policyRuntimeFunctionsFor([policy])
): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	hooks: { entries: authoredHooks(entriesHooks) }
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
				{}
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

		const committed = await mutate(harness, 'approval-none', ' Ordinary ');
		expect(committed.records).toHaveLength(1);
		expect(committed.records[0]).toMatchObject({ normalized: 'ordinary' });
		await expect(mutate(harness, 'approval-review', ' REVIEW ')).rejects.toBeInstanceOf(
			Collections.PendingApproval
		);
		expect(seen).toEqual(['ordinary', 'review']);
		expect(exposedWrites).toEqual([false, false]);
	});

	it('holds only gated roots while committing and returning ordinary roots deterministically', async () => {
		const policy = describedPolicy((context) =>
			Reflect.get(Reflect.get(context as object, 'record') as object, 'normalized') === 'review'
				? approveBy('Reviewers')
				: noApproval
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });
		const committedId = '00000000-0000-4000-8000-000000000231';
		const heldId = '00000000-0000-4000-8000-000000000232';

		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).mutate(
					EffectId.make('approval-mixed-roots'),
					writer,
					'entries',
					[
						{ id: committedId, label: ' Ordinary ' },
						{ id: heldId, label: ' REVIEW ' }
					],
					false,
					0,
					{
						roots: [
							{ id: committedId, action: 'create' },
							{ id: heldId, action: 'create' }
						]
					}
				);
			})
		);

		// The batch result is the commit: the settled records in batch order, held roots present as
		// their bare id because nothing was written for them.
		expect(result.records).toEqual([
			expect.objectContaining({ id: committedId, normalized: 'ordinary' }),
			{ id: heldId }
		]);
		expect(await harness.database.query('select id from entries order by id')).toEqual([
			{ id: committedId }
		]);
		expect(
			await harness.database.query(
				'select record_id, status from approval_request order by record_id'
			)
		).toEqual([{ record_id: heldId, status: 'ONGOING' }]);
		expect(
			await harness.database.query(
				"select record_id from bolt_collection_history where collection_name = 'entries' order by record_id"
			)
		).toEqual([{ record_id: committedId }]);
	});

	it('runs write authorization against the same prepared object and accepts only true', async () => {
		const policy = describedPolicy(
			() => noApproval,
			(context) =>
				Reflect.get(Reflect.get(context as object, 'record') as object, 'normalized') === 'allowed'
		);
		harness = await makeBoltTestRuntime(definitionFor(policy), { authored: authoredFor(policy) });

		const allowed = await mutate(harness, 'authorization-allow', ' ALLOWED ');
		expect(allowed.records).toHaveLength(1);
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
