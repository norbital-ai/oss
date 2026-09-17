import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import type { AuthoredCollectionModule } from '../src/authoring/collection-schema.js';
import { Subject } from '../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * A held write whose transform read another collection.
 *
 * The read is fingerprinted during preparation, so the hold is persisted inside a transaction that
 * revalidates it first. Colony's database binding answers a transaction with every statement's rows,
 * so the `bolt_assert` row of that revalidation precedes the request row. Under that binding the hold
 * once committed but the reply was quarantined, and the ledger it left behind made the approved
 * resume conflict.
 */

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
const recommendations: AuthoredCollectionModule = {
	update: { input: { columns: { fae_state: true } } },
	transform: (
		inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
		context: Readonly<{ db: unknown }>
	) =>
		Effect.gen(function* () {
			const db = context.db as Readonly<{
				issues: Readonly<{
					findMany: (input: { limit: number }) => Effect.Effect<ReadonlyArray<unknown>>;
				}>;
			}>;
			const issues = yield* db.issues.findMany({ limit: 10 });
			observed.push(`transform:${issues.length}`);
			return inputs;
		})
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

describe('a hold whose transform read other collections', () => {
	for (const transactionRows of ['last', 'every'] as const) {
		it(`is held and then sealed by the decision (binding answers ${transactionRows} rows)`, async () => {
			harness = await makeBoltTestRuntime(definition, {
				transactionRows,
				authored: {
					...emptyAuthoredRuntime,
					policyAuthorizations: functions.authorizations,
					approvalFlows: functions.approvalFlows,
					collections: { recommendations }
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

			const commit = await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).write(effectId('decide'), controller, [
						{
							collection: 'recommendations',
							action: 'update',
							inputs: [{ id, fae_state: 'approved' }]
						}
					]);
				})
			);
			const requestId = commit.pendingApproval?.requestId ?? '';
			expect(requestId).not.toBe('');
			expect(
				await database.query('select fae_state, approval_id from recommendations where id = $1', [
					id
				])
			).toEqual([{ fae_state: 'approved', approval_id: requestId }]);
			expect(observed).toEqual(['transform:1']);

			await runtime.runPromise(
				Effect.gen(function* () {
					const approvals = yield* Approvals.Service;
					const pending = yield* approvals.status(effectId('status'), requestId);
					if (pending?._tag !== 'Pending')
						throw new Error(`expected Pending, received ${String(pending?._tag)}`);
					yield* approvals.decide(effectId('approve'), fae, pending, 'approve');
					yield* (yield* Collections.Service).resume(effectId('resume'), requestId);
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
					[requestId]
				)
			).toEqual([{ status: 'APPROVED', applied: true }]);
			// The seal re-applies nothing, so the transform ran once.
			expect(observed).toEqual(['transform:1']);
		});
	}
});
