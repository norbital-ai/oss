import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/index.js';
import { Collections } from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * That a record and the records that belong to it are written together, or not at all.
 *
 * The shape this replaces: a payroll run was committed, and *then* its payslips were written in a
 * second transaction, their lines in a third, their source claims in a fourth. A build that died
 * between them left a run row with no payslips — not a hypothesis, the local database was holding 92
 * payslips and 15 lines from exactly that. What makes the difference is that the parent's id is
 * minted before the transaction rather than by it, so a child can carry a foreign key to a row that
 * does not exist yet, and both statements go in the same envelope.
 */
const definition = workspace({
	name: 'nested',
	version: '1.0.0',
	collections: [
		collection({ name: 'orders', fields: { reference: field.string({ required: true }) } }),
		collection({
			name: 'order_lines',
			fields: {
				order_id: field.string({ required: true }),
				sku: field.string({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'order_line_order',
			source: 'orders',
			target: 'order_lines',
			cardinality: 'many',
			from: { collection: 'order_lines', column: 'order_id' },
			to: { collection: 'orders', column: 'norbital_id' }
		}
	],
	apps: [app({ name: 'nested', label: 'Nested' })],
	// A team name maps to the policy names its members hold; `teamPath` on the subject names teams.
	teams: { admin: ['admin-data'] },
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'orders', action: 'create' },
				{ collection: 'orders', action: 'read' },
				{ collection: 'order_lines', action: 'create' },
				{ collection: 'order_lines', action: 'read' }
			]
		})
	]
});

/** The hook returns a graph, which is the case the whole design exists for. */
const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		orders: {
			create: {
				perRecord: {
					before: {
						description: 'Expands an order into its lines.',
						handler: (context: unknown) => ({
							reference: (context as CreateContext).input['reference'],
							order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
						})
					}
				}
			}
		}
	}
};

/** What the runtime hands a create hook. Cast to, because the authored module types it `unknown`. */
type CreateContext = { readonly input: Record<string, unknown> };

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const write = (values: Record<string, unknown>) =>
	Effect.gen(function* () {
		const collections = yield* Collections.Service;
		return yield* collections.mutate(EffectId.make('nested-1'), adminSubject, 'orders', [values]);
	});

describe('a nested write', () => {
	it('commits the parent and its children in one transaction', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		harness.database.forget();

		await harness.runtime.runPromise(write({ reference: 'ORD-1' }));

		// One transaction, not three: the call count is the shape under test, the same way
		// `mutation-facility-budget.test.ts` measures the batch.
		const writes = harness.database.calls.length;
		const orders = await harness.database.query('select norbital_id, reference from orders');
		const lines = await harness.database.query(
			'select order_id, sku from order_lines order by sku'
		);

		expect(orders).toHaveLength(1);
		expect(lines).toHaveLength(2);
		// The link the author never wrote: filled from the parent's assigned id.
		expect(lines.map((row) => row['order_id'])).toEqual([
			orders[0]!['norbital_id'],
			orders[0]!['norbital_id']
		]);
		expect(writes).toBeLessThan(5);
	}, 60_000);

	it('refuses a key that is neither a column nor a declared relation, rather than dropping it', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...authored,
				hooks: {
					orders: {
						create: {
							perRecord: {
								before: {
									description: 'Returns a misspelled relation name.',
									handler: (context: unknown) => ({
										reference: (context as CreateContext).input['reference'],
										order_line_orders: [{ sku: 'a-1' }]
									})
								}
							}
						}
					}
				}
			}
		});

		// `Effect.result`, not `Effect.either` — v4 renamed it, and the old name is not a compile error.
		const outcome = await harness.runtime.runPromise(Effect.result(write({ reference: 'ORD-2' })));
		expect(outcome._tag).toBe('Failure');
		expect(JSON.stringify(outcome)).toContain('order_line_orders');

		// And nothing was written, because the refusal happened before the transaction.
		const orders = await harness.database.query('select norbital_id from orders');
		expect(orders).toHaveLength(0);
	}, 60_000);
});

/**
 * That a batch's reads can be hoisted without the rule being written twice.
 *
 * A hook is authored for one record, and one that reads is an N+1 by construction: the attendance
 * rules ask two questions per row, so a four-thousand-row import asks eight thousand times. `load`
 * is where the query a person would actually write goes — one read over the window the batch spans.
 *
 * What is counted here is how many times `load` ran against how many records it served, because
 * that ratio *is* the feature. The rule stays in `handler`, once, which is the difference between
 * this and the `batchHandler` it replaces — that one was a second place to write the rule, and the
 * template it shipped in had the same assertion in both halves.
 */
describe('a batch prepare', () => {
	const prepareCalls: Array<number> = [];
	const withPrepare = {
		...emptyAuthoredRuntime,
		hooks: {
			orders: {
				create: {
					// Once for the batch. Returns data; decides nothing.
					prepare: (context: unknown) => {
						const { inputs } = context as { inputs: ReadonlyArray<Record<string, unknown>> };
						prepareCalls.push(inputs.length);
						return { seen: new Set(inputs.map((input) => String(input['reference']))) };
					},
					perRecord: {
						before: {
							description: 'Rejects a reference the batch has already claimed.',
							handler: (context: unknown) => {
								const { input, prepared } = context as CreateContext & {
									prepared: { seen: Set<string> };
								};
								return {
									reference: prepared.seen.has(String(input['reference']))
										? String(input['reference'])
										: 'unclaimed'
								};
							}
						}
					}
				}
			}
		}
	};

	it('runs once for the batch and feeds every record in it', async () => {
		prepareCalls.length = 0;
		harness = await makeBoltTestRuntime(definition, { authored: withPrepare });

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					EffectId.make('load-1'),
					adminSubject,
					'orders',
					Array.from({ length: 6 }, (_, index) => ({ reference: `ORD-${index}` }))
				);
			})
		);

		// One call, six records — not six calls.
		expect(prepareCalls).toEqual([6]);
		const rows = await harness.database.query('select reference from orders');
		expect(rows).toHaveLength(6);
		// And every handler saw what `load` returned, rather than `undefined`.
		expect(rows.every((row) => row['reference'] !== 'unclaimed')).toBe(true);
	}, 60_000);

	it('runs once per batch when the call is split, and sees only its own rows', async () => {
		prepareCalls.length = 0;
		harness = await makeBoltTestRuntime(definition, { authored: withPrepare });

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					EffectId.make('load-2'),
					adminSubject,
					'orders',
					Array.from({ length: 5 }, (_, index) => ({ reference: `ORD-${index}` })),
					false,
					0,
					{ batchSize: 2 }
				);
			})
		);

		// A batch is the unit of atomicity and of the isolate's span, so it is the unit a read is
		// scoped to as well.
		expect(prepareCalls).toEqual([2, 2, 1]);
	}, 60_000);
});
