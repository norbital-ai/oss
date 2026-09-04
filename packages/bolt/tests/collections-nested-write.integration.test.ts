import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import {
	authoredHooks,
	type CollectionHooks,
	type MutateGraph
} from '../src/authoring/contracts-schema.js';
import { AuthoredRefusal } from '../src/authoring/refusal.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

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
				order_id: field.string({ required: false }),
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
			from: { collection: 'orders', column: 'id' },
			to: { collection: 'order_lines', column: 'order_id' },
			cascade: true
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
				{ collection: 'orders', action: 'update' },
				{ collection: 'orders', action: 'delete' },
				{ collection: 'orders', action: 'read' },
				{ collection: 'order_lines', action: 'create' },
				{ collection: 'order_lines', action: 'update' },
				{ collection: 'order_lines', action: 'delete' },
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
				readonly order_id: string | null;
				readonly sku: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly order_id?: string | null;
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

const createLine = (runtime: BoltTestRuntime, effectId: string, values: Record<string, unknown>) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			const result = yield* collections.mutate(
				EffectId.make(effectId),
				adminSubject,
				'order_lines',
				[values]
			);
			const id = result.records[0]?.['id'];
			if (typeof id !== 'string') throw new Error('created line has no id');
			return id;
		})
	);

const createOrder = (runtime: BoltTestRuntime, effectId: string, reference: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			const result = yield* collections.mutate(EffectId.make(effectId), adminSubject, 'orders', [
				{ reference }
			]);
			const id = result.records[0]?.['id'];
			if (typeof id !== 'string') throw new Error('created order has no id');
			return id;
		})
	);

const claimLinesAuthored = (lineIds: ReadonlyArray<string>, refuseSku?: string) => ({
	...emptyAuthoredRuntime,
	hooks: {
		orders: authoredHooks<NestedWriteSchema, 'orders'>({
			mutate: {
				perRecord: {
					before: {
						description: 'Attaches explicitly selected existing lines to the new order.',
						handler: ({ input }) =>
							({
								...input,
								order_line_order: lineIds.map((id) => ({ id }))
							}) as MutateGraph<NestedWriteSchema, 'orders'>
					}
				}
			}
		}),
		...(refuseSku === undefined
			? {}
			: {
					order_lines: authoredHooks<NestedWriteSchema, 'order_lines'>({
						mutate: {
							perRecord: {
								before: {
									description: 'Refuses the selected stored line to prove graph rollback.',
									handler: ({ input, existing }) =>
										existing?.sku === refuseSku
											? Effect.fail(new AuthoredRefusal({ message: 'claimed line refused' }))
											: Effect.succeed(input)
								}
							}
						}
					})
				})
	}
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

	it('captures every nested create and cascade delete from the committed graph', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				const created = yield* collections.mutate(
					EffectId.make('nested-capture-create'),
					adminSubject,
					'orders',
					[{ reference: 'ORD-CAPTURE' }]
				);
				const createBatch = yield* syncCommit.drainChanges;
				const orderId = String(created.records[0]?.['id']);
				yield* collections.delete(EffectId.make('nested-capture-delete'), adminSubject, 'orders', [
					orderId
				]);
				const deleteBatch = yield* syncCommit.drainChanges;
				return { orderId, createBatch, deleteBatch };
			})
		);

		expect(result.createBatch).toHaveLength(3);
		expect(result.createBatch).toContainEqual({
			collection: 'orders',
			id: result.orderId,
			operation: 'insert',
			after: {}
		});
		const createdLines = result.createBatch.filter((change) => change.collection === 'order_lines');
		expect(createdLines).toHaveLength(2);
		expect(
			createdLines.every(
				(change) => change.operation === 'insert' && change.after?.['order_id'] === result.orderId
			)
		).toBe(true);

		expect(result.deleteBatch).toHaveLength(3);
		expect(result.deleteBatch).toContainEqual({
			collection: 'orders',
			id: result.orderId,
			operation: 'delete',
			before: {}
		});
		const deletedLines = result.deleteBatch.filter((change) => change.collection === 'order_lines');
		expect(deletedLines).toHaveLength(2);
		expect(
			deletedLines.every(
				(change) => change.operation === 'delete' && change.before?.['order_id'] === result.orderId
			)
		).toBe(true);
	}, 60_000);

	it('does not put cascade-child row bodies on the delete history snapshot', async () => {
		const fat = 'payload-body-'.repeat(200);
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					orders: authoredHooks<NestedWriteSchema, 'orders'>({
						mutate: {
							perRecord: {
								before: {
									description: 'Expands an order into one fat line.',
									handler: ({ input }) => ({
										...(input.reference === undefined ? {} : { reference: input.reference }),
										order_line_order: [{ sku: fat }]
									})
								}
							}
						}
					})
				}
			}
		});
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const created = yield* collections.mutate(
					EffectId.make('fat-cascade-create'),
					adminSubject,
					'orders',
					[{ reference: 'ORD-FAT' }]
				);
				const orderId = String(created.records[0]?.['id']);
				yield* collections.delete(EffectId.make('fat-cascade-delete'), adminSubject, 'orders', [
					orderId
				]);
			})
		);
		const history = await harness.database.query(
			`select collection_name, record_id, snapshot::text as snapshot from bolt_collection_history where operation = 'delete' order by collection_name, record_id`
		);
		expect(history.length).toBeGreaterThan(0);
		for (const row of history) {
			const snapshot = String(row['snapshot'] ?? '');
			expect(
				snapshot.includes(fat),
				`${row['collection_name']} history still carried the row body`
			).toBe(false);
			expect(snapshot).toContain(String(row['record_id']));
		}
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

	it('lets a trusted authored graph claim a null-owned child without overwriting omitted fields', async () => {
		const claimedIds: Array<string> = [];
		harness = await makeBoltTestRuntime(definition, {
			authored: claimLinesAuthored(claimedIds)
		});
		const lineId = await createLine(harness, 'claim-null-owned-seed', {
			sku: 'attendance-only-facts'
		});
		const before = await harness.database.query(
			'select id, order_id, sku from order_lines where id = $1',
			[lineId]
		);
		expect(before).toEqual([{ id: lineId, order_id: null, sku: 'attendance-only-facts' }]);
		claimedIds.push(lineId);

		const orderId = await createOrder(harness, 'claim-null-owned', 'ROSTER-2026-01');
		expect(
			await harness.database.query('select id, order_id, sku from order_lines where id = $1', [
				lineId
			])
		).toEqual([{ id: lineId, order_id: orderId, sku: 'attendance-only-facts' }]);
	}, 60_000);

	it('lets a server-only payload claim a stored null-owned child', async () => {
		harness = await makeBoltTestRuntime(definition);
		const lineId = await createLine(harness, 'server-claim-seed', { sku: 'claim-from-payload' });
		const orderId = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const result = yield* (yield* Collections.Service).mutate(
					EffectId.make('server-only-payload-claim'),
					adminSubject,
					'orders',
					[{ reference: 'SERVER-CLAIM', order_line_order: [{ id: lineId }] }]
				);
				const id = result.records[0]?.['id'];
				if (typeof id !== 'string') throw new Error('created order has no id');
				return id;
			})
		);

		expect(
			await harness.database.query('select id, order_id, sku from order_lines where id = $1', [
				lineId
			])
		).toEqual([{ id: lineId, order_id: orderId, sku: 'claim-from-payload' }]);
	}, 60_000);

	it('refuses a trusted authored graph that names a child owned by another parent', async () => {
		const claimedIds: Array<string> = [];
		harness = await makeBoltTestRuntime(definition, {
			authored: claimLinesAuthored(claimedIds)
		});
		const existingOwnerId = await createOrder(harness, 'owned-elsewhere-parent', 'OWNER');
		const lineId = await createLine(harness, 'owned-elsewhere-line', {
			order_id: existingOwnerId,
			sku: 'owned-elsewhere'
		});
		claimedIds.push(lineId);

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('owned-elsewhere-claim'),
						adminSubject,
						'orders',
						[{ reference: 'ATTEMPTED-NEW-OWNER' }]
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id, reference from orders')).toEqual([
			{ id: existingOwnerId, reference: 'OWNER' }
		]);
		expect(
			await harness.database.query('select order_id from order_lines where id = $1', [lineId])
		).toEqual([{ order_id: existingOwnerId }]);
	}, 60_000);

	it('persists nested children with explicit ids on a server-only create', async () => {
		harness = await makeBoltTestRuntime(definition);
		const orderId = recordId('server-only-nested-order');
		const lineId = recordId('server-only-nested-line');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).mutate(
					EffectId.make('server-only-nested-create'),
					adminSubject,
					'orders',
					[
						{
							id: orderId,
							reference: 'ORD-NESTED',
							order_line_order: [{ id: lineId, sku: 'nested-1' }]
						}
					],
					true,
					0,
					{ roots: [{ id: orderId, action: 'create' }] }
				);
			})
		);

		expect(await harness.database.query('select id, reference from orders')).toEqual([
			{ id: orderId, reference: 'ORD-NESTED' }
		]);
		expect(await harness.database.query('select id, order_id, sku from order_lines')).toEqual([
			{ id: lineId, order_id: orderId, sku: 'nested-1' }
		]);
	}, 60_000);

	it('persists a new nested child id on a server-only update', async () => {
		harness = await makeBoltTestRuntime(definition);
		const orderId = await createOrder(harness, 'server-only-update-parent', 'ORD-EXISTING');
		const lineId = recordId('server-only-update-line');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).mutate(
					EffectId.make('server-only-nested-update'),
					adminSubject,
					'orders',
					[
						{
							id: orderId,
							order_line_order: [{ id: lineId, sku: 'added-1' }]
						}
					],
					true,
					0,
					{ roots: [{ id: orderId, action: 'update' }] }
				);
			})
		);

		expect(await harness.database.query('select id, order_id, sku from order_lines')).toEqual([
			{ id: lineId, order_id: orderId, sku: 'added-1' }
		]);
	}, 60_000);

	it('rolls back every claim and the parent when any claimed child hook refuses', async () => {
		const lineIds: Array<string> = [];
		harness = await makeBoltTestRuntime(definition, {
			authored: claimLinesAuthored(lineIds, 'refuse-this-line')
		});
		lineIds.push(
			await createLine(harness, 'claim-rollback-first', { sku: 'would-have-been-claimed' }),
			await createLine(harness, 'claim-rollback-second', { sku: 'refuse-this-line' })
		);

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('claim-rollback-parent'),
						adminSubject,
						'orders',
						[{ reference: 'MUST-ROLL-BACK' }]
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(JSON.stringify(outcome)).toContain('claimed line refused');
		expect(await harness.database.query('select id from orders')).toEqual([]);
		expect(
			await harness.database.query('select order_id, sku from order_lines order by sku')
		).toEqual([
			{ order_id: null, sku: 'refuse-this-line' },
			{ order_id: null, sku: 'would-have-been-claimed' }
		]);
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
