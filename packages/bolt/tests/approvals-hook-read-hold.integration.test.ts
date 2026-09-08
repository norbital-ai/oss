import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy } from '../src/authoring/approval-flow.js';
import { authoredHooks, type CollectionHooks } from '../src/authoring/contracts-schema.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { PendingApproval } from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { Subject } from '../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/**
 * A held write whose before-hook read another collection.
 *
 * The read is fingerprinted during preparation, so the hold is persisted inside a transaction that
 * revalidates it first. Colony's database binding answers a transaction with every statement's rows,
 * so the `bolt_assert` row of that revalidation precedes the request row. Under that binding the hold
 * committed but the reply was quarantined, and the ledger it left behind made the approved resume
 * conflict. serial-pcn's `recommendations` before-hook reads six collections; `categories` reads none.
 */

interface Schema {
	readonly tables: {
		readonly recommendations: {
			readonly $inferSelect: {
				readonly id: string;
				readonly unit_price: string | null;
				readonly breakdown: unknown;
				readonly fae_state: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly unit_price?: string | null;
				readonly breakdown?: unknown;
				readonly fae_state: string;
			};
		};
		readonly issues: {
			readonly $inferSelect: { readonly id: string; readonly title: string };
			readonly $inferInsert: { readonly id?: string; readonly title: string };
		};
	};
	readonly relations: Record<string, never>;
}

const policy = describePolicy('controller', {
	description: 'A recommendation decision is a proposal until the FAE approves it.',
	grants: {
		issues: { read: {} },
		recommendations: {
			read: {},
			mutate: { existing: { approval: { flow: () => approveBy('FAE'), superceded_by: ['FAE'] } } }
		}
	}
});

const definition = workspace({
	name: 'hook-read-hold',
	version: '1.0.0',
	collections: [
		collection({
			name: 'recommendations',
			fields: {
				unit_price: { ...field.number(), sqlType: 'numeric' },
				breakdown: field.json(),
				fae_state: field.string({ required: true })
			}
		}),
		collection({ name: 'issues', fields: { title: field.string({ required: true }) } })
	],
	apps: [],
	policies: [policy],
	teams: { Controllers: ['controller'], FAE: [] },
	automations: [],
	integrations: [],
	prompt: 'Hold a decision whose preparation read the world.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const observed: Array<string> = [];
const hooks: CollectionHooks<Schema, 'recommendations'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'A decision applies only against the current issue.',
				handler: ({ input, api }) =>
					Effect.gen(function* () {
						const issues = yield* api.db.issues.findMany({ limit: 10 });
						observed.push(`before:${issues.length}`);
						return input;
					})
			},
			after: {
				description: 'Reads the settled row back.',
				handler: ({ record, api }) =>
					Effect.gen(function* () {
						const stored = yield* api.db.recommendations.findFirst({
							where: { id: { eq: record.id } }
						});
						observed.push(`after:${String(stored?.fae_state)}`);
					})
			}
		}
	}
};

const functions = policyRuntimeFunctionsFor([policy]);
const controller = Subject.make({
	userId: 'controller-1',
	tenantId: adminSubject.tenantId,
	teamPath: ['Controllers'],
	policies: []
});
const fae = { ...adminSubject, admin: false, teamPath: ['FAE'] };

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
	observed.length = 0;
});

describe('a hold whose preparation read other collections', () => {
	for (const transactionRows of ['last', 'every'] as const) {
		it(`is held and then committed by the decision (binding answers ${transactionRows} rows)`, async () => {
			harness = await makeBoltTestRuntime(definition, {
				transactionRows,
				authored: {
					...emptyAuthoredRuntime,
					policyAuthorizations: functions.authorizations,
					approvalFlows: functions.approvalFlows,
					hooks: { recommendations: authoredHooks(hooks) }
				}
			});
			const { runtime, effectId, database } = harness;
			const id = recordId('recommendation-1');
			await database.query('insert into issues (id, title) values ($1, $2)', [
				recordId('issue-1'),
				'PCN-1'
			]);
			await database.query(
				'insert into recommendations (id, unit_price, breakdown, fae_state) values ($1, $2, $3::jsonb, $4)',
				[id, '12.50', JSON.stringify({ savings: 3.25, notes: ['a'] }), 'pending']
			);

			const failure = await runtime.runPromise(
				Effect.flip(
					Effect.gen(function* () {
						const collections = yield* Collections.Service;
						return yield* collections.mutate(
							effectId('decide'),
							controller,
							'recommendations',
							[{ id, fae_state: 'approved' }],
							0,
							{ roots: [{ id, action: 'update' }] }
						);
					})
				)
			);
			const held = unwrapMutationPhase(failure);
			expect(held, held instanceof Error ? held.message : String(held)).toBeInstanceOf(
				PendingApproval
			);
			if (!(held instanceof PendingApproval)) throw new Error('write was not held');
			expect(
				await database.query(
					'select fae_state, approval_id from recommendations where id = $1',
					[id]
				)
			).toEqual([{ fae_state: 'pending', approval_id: held.requestId }]);
			expect(observed).toEqual(['before:1']);

			await runtime.runPromise(
				Effect.gen(function* () {
					const approvals = yield* Approvals.Service;
					const pending = yield* approvals.status(effectId('status'), held.requestId);
					if (pending?._tag !== 'Pending')
						throw new Error(`expected Pending, received ${String(pending?._tag)}`);
					yield* approvals.decide(effectId('approve'), fae, pending, 'approve');
					yield* (yield* Collections.Service).resume(effectId('resume'), held.requestId);
				})
			);
			expect(
				await database.query(
					'select fae_state, unit_price, breakdown, approval_id from recommendations where id = $1',
					[id]
				)
			).toEqual([
				{
					fae_state: 'approved',
					unit_price: 12.5,
					breakdown: { savings: 3.25, notes: ['a'] },
					approval_id: null
				}
			]);
			expect(
				await database.query(
					'select status, applied_at is not null as applied from approval_request where id = $1',
					[held.requestId]
				)
			).toEqual([{ status: 'APPROVED', applied: true }]);
			expect(observed).toEqual(['before:1', 'before:1', 'after:approved']);
		});
	}
});
