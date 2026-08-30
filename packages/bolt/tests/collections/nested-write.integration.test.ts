import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import {
	authoredHooks,
	type CollectionHooks,
	type MutateGraph
} from '../../src/authoring/contracts-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
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
			to: { collection: 'orders', column: 'id' }
		}
	],
	apps: [app({ name: 'nested', label: 'Nested' })],
	// A team name maps to the policy names its members hold; `teamPath` on the subject names teams.
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
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

/**
 * The two fixtures as a schema, so the hooks are typed the way a compiled workspace's are: the
 * many edge is declared with the endpoint the mutations own, which lets a `before` return a child
 * graph without naming the foreign key.
 */
interface NestedWriteSchema {
	readonly tables: {
		readonly orders: {
			readonly $inferSelect: {
				readonly id: string;
				readonly reference: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly reference: string;
			};
		};
		readonly order_lines: {
			readonly $inferSelect: {
				readonly id: string;
				readonly order_id: string;
				readonly sku: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly order_id: string;
				readonly sku: string;
			};
		};
	};
	readonly relations: {
		readonly orders: {
			readonly order_line_order: {
				readonly cardinality: 'many';
				readonly target: 'order_lines';
				readonly column: 'order_id';
				readonly parentColumn: 'id';
			};
		};
	};
}

/** The hook returns a graph, which is the case the whole design exists for. */
const orderHooks: CollectionHooks<NestedWriteSchema, 'orders'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'Expands an order into its lines.',
				handler: ({ input }) => ({
					...(input.reference === undefined ? {} : { reference: input.reference }),
					order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
				})
			}
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	hooks: { orders: authoredHooks(orderHooks) }
};

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
		const orders = await harness.database.query('select id, reference from orders');
		const lines = await harness.database.query(
			'select order_id, sku from order_lines order by sku'
		);

		expect(orders).toHaveLength(1);
		expect(lines).toHaveLength(2);
		// The link the author never wrote: filled from the parent's assigned id.
		expect(lines.map((row) => row['order_id'])).toEqual([orders[0]!['id'], orders[0]!['id']]);
		expect(writes).toBeLessThan(5);
	}, 60_000);

	it('refuses a key that is neither a column nor a declared relation, rather than dropping it', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...authored,
				hooks: {
					orders: authoredHooks<NestedWriteSchema, 'orders'>({
						mutate: {
							perRecord: {
								before: {
									description: 'Returns a misspelled relation name.',
									handler: ({ input }) => {
										// The misspelled key is the point of the test: it is a type error on a returned
										// literal, so the handler builds the graph in a variable — which is exactly the
										// shape the runtime's FLATTEN refuses before the transaction.
										const misspelled = {
											reference: input.reference,
											order_line_orders: [{ sku: 'a-1' }]
										};
										return misspelled as MutateGraph<NestedWriteSchema, 'orders'>;
									}
								}
							}
						}
					})
				}
			}
		});

		// `Effect.result`, not `Effect.either` — v4 renamed it, and the old name is not a compile error.
		const outcome = await harness.runtime.runPromise(Effect.result(write({ reference: 'ORD-2' })));
		expect(outcome._tag).toBe('Failure');
		expect(JSON.stringify(outcome)).toContain('order_line_orders');

		// And nothing was written, because the refusal happened before the transaction.
		const orders = await harness.database.query('select id from orders');
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
 * that ratio *is* the feature. The rule stays in `handler`, once, while preparation only loads the
 * shared data it needs.
 */
describe('a batch prepare', () => {
	const prepareCalls: Array<number> = [];
	const withPrepare = {
		...emptyAuthoredRuntime,
		hooks: {
			orders: authoredHooks<NestedWriteSchema, 'orders', { readonly seen: Set<string> }>({
				mutate: {
					// Once for the batch. Returns data; decides nothing.
					prepare: ({ inputs }) => {
						prepareCalls.push(inputs.length);
						return { seen: new Set(inputs.map((input) => String(input.reference))) };
					},
					perRecord: {
						before: {
							description: 'Rejects a reference the batch has already claimed.',
							handler: ({ input, prepared }) => ({
								reference: prepared.seen.has(String(input.reference))
									? String(input.reference)
									: 'unclaimed'
							})
						}
					}
				}
			})
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
});
