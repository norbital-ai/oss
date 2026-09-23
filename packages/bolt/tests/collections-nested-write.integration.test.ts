import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The nested-write grammar (RFC §4.3): a record and the records that belong to it are written
 * together, or not at all, through explicit relation actions.
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
				order_id: field.uuid({ required: false }),
				sku: field.string({ required: true })
			}
		}),
		collection({
			name: 'line_notes',
			fields: {
				line_id: field.uuid({ required: true }),
				body: field.string({ required: true })
			}
		}),
		// A row an order pins rather than owns: deleting the order releases it, never takes it.
		collection({
			name: 'shipments',
			fields: {
				order_id: field.uuid({ required: false }),
				carrier: field.string({ required: true })
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
		},
		{
			name: 'line_note_line',
			source: 'order_lines',
			target: 'line_notes',
			cardinality: 'many',
			from: { collection: 'order_lines', column: 'id' },
			to: { collection: 'line_notes', column: 'line_id' },
			cascade: true
		},
		{
			name: 'shipment_order',
			source: 'orders',
			target: 'shipments',
			cardinality: 'many',
			from: { collection: 'orders', column: 'id' },
			to: { collection: 'shipments', column: 'order_id' },
			setNull: true
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
	channels: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: (['orders', 'order_lines', 'line_notes', 'shipments'] as const).flatMap((name) =>
				(['create', 'read', 'update', 'delete'] as const).map((action) => ({
					collection: name,
					action
				}))
			)
		})
	]
});

const lineSelection = {
	create: {
		columns: { sku: true },
		with: { line_note_line: { create: { columns: { body: true } } } }
	},
	update: { columns: { sku: true } },
	link: { columns: {} },
	unlink: { columns: {} },
	delete: {}
} as const;

/** The declared contract: an order with its lines, and a line with its notes, written inline. */
const declared: AuthoredRuntime['collections'] = {
	orders: {
		create: { input: { columns: { reference: true }, with: { order_line_order: lineSelection } } },
		update: { input: { columns: { reference: true }, with: { order_line_order: lineSelection } } },
		delete: {}
	},
	order_lines: {
		create: { input: { columns: { order_id: true, sku: true } } },
		update: { input: { columns: { order_id: true, sku: true } } },
		delete: {}
	},
	shipments: {
		create: { input: { columns: { order_id: true, carrier: true } } },
		update: { input: { columns: { order_id: true, carrier: true } } },
		delete: {}
	}
};

type Payload = Readonly<Record<string, unknown>>;

/** A transform returning a graph, which is the case the whole design exists for. */
const expandingTransform = (inputs: ReadonlyArray<Payload>) =>
	Effect.succeed(
		inputs.map((input) => ({
			...input,
			order_line_order: { create: [{ sku: 'a-1' }, { sku: 'a-2' }] }
		}))
	);

const authoredWith = (
	transform?: (inputs: ReadonlyArray<Payload>) => unknown
): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	collections: {
		...declared,
		orders: { ...declared.orders, ...(transform === undefined ? {} : { transform }) }
	}
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const write = (
	runtime: BoltTestRuntime,
	effectId: string,
	collection: string,
	action: 'create' | 'update' | 'delete',
	input: Payload
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			return yield* collections.write(EffectId.make(effectId), adminSubject, [
				{ collection, action, inputs: [input] }
			]);
		})
	);

const createLine = async (runtime: BoltTestRuntime, effectId: string, values: Payload) => {
	const result = await write(runtime, effectId, 'order_lines', 'create', values);
	const id = result.records[0]?.['id'];
	if (typeof id !== 'string') throw new Error('created line has no id');
	return id;
};

const createOrder = async (runtime: BoltTestRuntime, effectId: string, input: Payload) => {
	const result = await write(runtime, effectId, 'orders', 'create', input);
	const id = result.records[0]?.['id'];
	if (typeof id !== 'string') throw new Error('created order has no id');
	return id;
};

describe('a nested write', () => {
	it('commits the parent and its transform-added children in one transaction', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith(expandingTransform) });
		harness.database.forget();

		await write(harness, 'nested-1', 'orders', 'create', { reference: 'ORD-1' });

		// One transaction, not three: a declared create with no reads is one facility call.
		expect(harness.database.calls).toHaveLength(1);
		const orders = await harness.database.query('select id, reference from orders');
		const lines = await harness.database.query(
			'select order_id, sku from order_lines order by sku'
		);
		expect(orders).toHaveLength(1);
		expect(lines).toHaveLength(2);
		// The link the author never wrote: filled from the parent's assigned id.
		expect(lines.map((row) => row['order_id'])).toEqual([orders[0]!['id'], orders[0]!['id']]);
	}, 60_000);

	it('captures every nested create and the whole cascade closure of a delete', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				const created = yield* collections.write(
					EffectId.make('nested-capture-create'),
					adminSubject,
					[
						{
							collection: 'orders',
							action: 'create',
							inputs: [
								{
									reference: 'ORD-CAPTURE',
									order_line_order: {
										create: [
											{ sku: 'keep', line_note_line: { create: [{ body: 'retained' }] } },
											{ sku: 'drop' }
										]
									}
								}
							]
						}
					]
				);
				const createBatch = yield* syncCommit.drainChanges;
				const orderId = String(created.records[0]?.['id']);
				yield* collections.write(EffectId.make('nested-capture-delete'), adminSubject, [
					{ collection: 'orders', action: 'delete', inputs: [{ id: orderId }] }
				]);
				const deleteBatch = yield* syncCommit.drainChanges;
				return { orderId, createBatch, deleteBatch };
			})
		);

		expect(result.createBatch).toHaveLength(4);
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
		// The grandchild names the line's guest-allocated id.
		const note = result.createBatch.find((change) => change.collection === 'line_notes');
		expect(note?.operation).toBe('insert');
		expect(createdLines.map((change) => change.id)).toContain(
			note?.operation === 'insert' ? note.after['line_id'] : undefined
		);

		// The engine read the cascade closure before the transaction (RFC §4.3): the order, both
		// lines and the note are one delete batch, and every row is gone.
		expect(result.deleteBatch).toHaveLength(4);
		expect(result.deleteBatch.map((change) => change.operation)).toEqual([
			'delete',
			'delete',
			'delete',
			'delete'
		]);
		expect(result.deleteBatch.map((change) => change.collection).toSorted()).toEqual([
			'line_notes',
			'order_lines',
			'order_lines',
			'orders'
		]);
		expect(await harness.database.query('select id from line_notes')).toEqual([]);
		expect(await harness.database.query('select id from order_lines')).toEqual([]);
	}, 60_000);

	it('releases the rows a deleted parent pinned as explicit updates, so the capture sees them', async () => {
		// A `setNull` edge used to be the database's alone: the key was cleared by `ON DELETE SET
		// NULL`, and nothing the transaction named said so — history, sync capture and change events
		// all missed it, so a browser replica kept the released row pinned until it was reset.
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				const created = yield* collections.write(
					EffectId.make('release-create-order'),
					adminSubject,
					[{ collection: 'orders', action: 'create', inputs: [{ reference: 'ORD-PIN' }] }]
				);
				const orderId = String(created.records[0]?.['id']);
				const pinned = yield* collections.write(EffectId.make('release-create-pin'), adminSubject, [
					{
						collection: 'shipments',
						action: 'create',
						inputs: [{ order_id: orderId, carrier: 'DHL' }]
					}
				]);
				yield* syncCommit.drainChanges;
				yield* collections.write(EffectId.make('release-delete'), adminSubject, [
					{ collection: 'orders', action: 'delete', inputs: [{ id: orderId }] }
				]);
				const deleteBatch = yield* syncCommit.drainChanges;
				return { orderId, shipmentId: String(pinned.records[0]?.['id']), deleteBatch };
			})
		);
		expect(result.deleteBatch).toContainEqual({
			collection: 'orders',
			id: result.orderId,
			operation: 'delete',
			before: {}
		});
		const released = result.deleteBatch.find((change) => change.collection === 'shipments');
		expect(released?.operation).toBe('update');
		expect(released?.operation === 'update' ? released.after['order_id'] : 'kept').toBeNull();
		expect(await harness.database.query('select id, order_id, carrier from shipments')).toEqual([
			{ id: result.shipmentId, order_id: null, carrier: 'DHL' }
		]);
	}, 60_000);

	it('does not put cascade-child row bodies on the delete history snapshot', async () => {
		const fat = 'payload-body-'.repeat(200);
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs) =>
				Effect.succeed(
					inputs.map((input) => ({ ...input, order_line_order: { create: [{ sku: fat }] } }))
				)
			)
		});
		const orderId = await createOrder(harness, 'fat-cascade-create', { reference: 'ORD-FAT' });
		await write(harness, 'fat-cascade-delete', 'orders', 'delete', { id: orderId });
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

	it('refuses a transform payload naming a key that is neither a column nor a relation, before the transaction', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs) =>
				Effect.succeed(
					inputs.map((input) => ({ ...input, order_line_orders: { create: [{ sku: 'a-1' }] } }))
				)
			)
		});
		await expect(
			write(harness, 'nested-2', 'orders', 'create', { reference: 'ORD-2' })
		).rejects.toThrow(/order_line_orders/);
		// And nothing was written, because the refusal happened before the transaction.
		expect(await harness.database.query('select id from orders')).toEqual([]);
	}, 60_000);

	it('links a stored null-owned child from the transform or the input without touching its other fields', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const first = await createLine(harness, 'link-seed-1', { sku: 'attendance-only-facts' });
		const second = await createLine(harness, 'link-seed-2', { sku: 'claim-from-payload' });
		expect(await harness.database.query('select order_id from order_lines')).toEqual([
			{ order_id: null },
			{ order_id: null }
		]);

		// The caller names the link in its declared input.
		const orderId = await createOrder(harness, 'link-from-input', {
			reference: 'ROSTER-2026-01',
			order_line_order: { link: [{ id: second }] }
		});
		// The transform names it: the workspace's own work, judged against nobody.
		await harness.dispose();
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs) =>
				Effect.succeed(
					inputs.map((input) => ({ ...input, order_line_order: { link: [{ id: first }] } }))
				)
			)
		});
		await harness.database.query('insert into order_lines (id, sku) values ($1, $2), ($3, $4)', [
			first,
			'attendance-only-facts',
			second,
			'claim-from-payload'
		]);
		const linkedByTransform = await createOrder(harness, 'link-from-transform', {
			reference: 'ROSTER-2026-02'
		});
		expect(
			await harness.database.query('select id, order_id, sku from order_lines order by sku')
		).toEqual([
			{ id: first, order_id: linkedByTransform, sku: 'attendance-only-facts' },
			{ id: second, order_id: null, sku: 'claim-from-payload' }
		]);
		expect(orderId).not.toBe(linkedByTransform);
	}, 60_000);

	it('keeps the ids an administrator names for nested children on create and on update', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const orderId = recordId('server-only-nested-order');
		const lineId = recordId('server-only-nested-line');
		await write(harness, 'server-only-nested-create', 'orders', 'create', {
			id: orderId,
			reference: 'ORD-NESTED',
			order_line_order: { create: [{ id: lineId, sku: 'nested-1' }] }
		});
		expect(await harness.database.query('select id, reference from orders')).toEqual([
			{ id: orderId, reference: 'ORD-NESTED' }
		]);
		expect(await harness.database.query('select id, order_id, sku from order_lines')).toEqual([
			{ id: lineId, order_id: orderId, sku: 'nested-1' }
		]);

		const added = recordId('server-only-update-line');
		await write(harness, 'server-only-nested-update', 'orders', 'update', {
			id: orderId,
			order_line_order: { create: [{ id: added, sku: 'added-1' }] }
		});
		expect(
			await harness.database.query('select id, order_id, sku from order_lines order by sku')
		).toEqual([
			{ id: added, order_id: orderId, sku: 'added-1' },
			{ id: lineId, order_id: orderId, sku: 'nested-1' }
		]);
	}, 60_000);

	it('rolls back the whole graph when a nested create omits a required field', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const orderId = await createOrder(harness, 'rollback-seed', {
			reference: 'Before',
			order_line_order: { create: [{ sku: 'existing' }] }
		});
		const [line] = await harness.database.query('select id from order_lines');
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).write(
						EffectId.make('rollback-invalid'),
						adminSubject,
						[
							{
								collection: 'orders',
								action: 'update',
								inputs: [
									{
										id: orderId,
										reference: 'Must roll back',
										order_line_order: {
											update: [{ id: String(line?.['id']), set: { sku: 'also rolled back' } }],
											create: [{}]
										}
									}
								]
							}
						]
					);
				})
			)
		);
		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'Before' }
		]);
		expect(await harness.database.query('select sku from order_lines')).toEqual([
			{ sku: 'existing' }
		]);
	}, 60_000);
});

describe('the writable many relation a nested action resolves through', () => {
	it('resolves direct many endpoints while inheriting cascade from the inverse one edge', () => {
		// The many edge is declared from the child's side, and only its inverse `one` edge cascades:
		// the resolver still finds the child column the parent fills and carries the cascade over.
		const childOriented = workspace({
			...definition,
			relations: [
				{
					name: 'order_line_order',
					source: 'orders',
					target: 'order_lines',
					cardinality: 'many',
					from: { collection: 'order_lines', column: 'order_id' },
					to: { collection: 'orders', column: 'id' }
				},
				{
					name: 'line_order',
					source: 'order_lines',
					target: 'orders',
					cardinality: 'one',
					from: { collection: 'order_lines', column: 'order_id' },
					to: { collection: 'orders', column: 'id' },
					cascade: true
				}
			]
		});
		expect(
			Collections.resolveWritableManyRelation(childOriented, 'orders', 'order_line_order')
		).toEqual({
			name: 'order_line_order',
			parentCollection: 'orders',
			parentColumn: 'id',
			childCollection: 'order_lines',
			childColumn: 'order_id',
			cascade: true,
			setNull: false
		});
	});
});
