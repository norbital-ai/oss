import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { platformCustomTypes } from '../src/authoring/models-schema.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The declared write path (collection RFC §4.2–4.4): one declared input, one transform, explicit
 * relation actions, and the same one-transaction commit the graph engine has always performed.
 *
 * The fixture keeps FK ownership on the child (`order_lines.order_id`) so a create can fill it from
 * the parent's allocated id, and leaves it nullable so `unlink` has something to clear.
 */
const baseDefinition = workspace({
	name: 'declared-write',
	version: '1.0.0',
	collections: [
		collection({
			name: 'orders',
			fields: {
				customer: field.string({ required: true }),
				total: field.number({}),
				// A `custom('instant_range')` column: the platform's own schema checks every write.
				window: { ...field.json({}), customType: 'instant_range' }
			}
		}),
		collection({
			name: 'order_lines',
			fields: {
				order_id: field.uuid({}),
				sku: field.string({ required: true }),
				qty: field.number({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'order_lines',
			source: 'orders',
			target: 'order_lines',
			cardinality: 'many',
			from: { collection: 'orders', column: 'id' },
			to: { collection: 'order_lines', column: 'order_id' },
			cascade: true
		}
	],
	apps: [],
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
	],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'Declared write fixture.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	customTypes: platformCustomTypes
});

const ordersWrite = {
	create: {
		input: {
			columns: { customer: true, total: true, window: true },
			with: {
				order_lines: {
					create: { columns: { sku: true, qty: true } }
				}
			}
		}
	},
	update: {
		input: {
			columns: { total: true },
			with: {
				order_lines: {
					create: { columns: { sku: true, qty: true } },
					update: { columns: { sku: true, qty: true } },
					upsert: { columns: { sku: true, qty: true } },
					link: { columns: { qty: true } },
					unlink: { columns: {} },
					delete: {}
				}
			}
		}
	}
} as const;

const linesWrite = {
	create: { input: { columns: { order_id: true, sku: true, qty: true } } },
	update: { input: { columns: { order_id: true, sku: true, qty: true } } },
	delete: {}
} as const;

const definition = {
	...baseDefinition,
	collections: baseDefinition.collections.map((entry) => ({ ...entry }))
};

const authored = (overrides: Partial<AuthoredRuntime> = {}): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	collections: {
		orders: ordersWrite,
		order_lines: linesWrite
	},
	...overrides
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const start = async (runtime: AuthoredRuntime = authored()): Promise<BoltTestRuntime> => {
	harness = await makeBoltTestRuntime(definition, { authored: runtime });
	harness.database.forget();
	return harness;
};

const write = (
	runtime: BoltTestRuntime,
	action: 'create' | 'update' | 'delete',
	input: Readonly<Record<string, unknown>>,
	collection = 'orders',
	baseVersions?: ReadonlyArray<
		Readonly<{
			readonly row: Readonly<{ readonly collection: string; readonly recordId: string }>;
			readonly rowVersion: number;
		}>
	>
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			return yield* collections.write(
				EffectId.make(`declared:${action}`),
				adminSubject,
				[{ collection, action, inputs: [input] }],
				baseVersions === undefined ? undefined : { baseVersions }
			);
		})
	);

describe('declared writes', () => {
	it('commits a root and its nested create children in one transaction', async () => {
		const runtime = await start();
		const commit = await write(runtime, 'create', {
			customer: 'Ada',
			total: 30,
			order_lines: {
				create: [
					{ sku: 'A-1', qty: 1 },
					{ sku: 'B-2', qty: 2 }
				]
			}
		});

		expect(commit.batch.changes.map((change) => change.collection).toSorted()).toEqual([
			'order_lines',
			'order_lines',
			'orders'
		]);
		const lines = (await runtime.database.query(
			'select order_id, sku, qty from order_lines order by sku'
		)) as ReadonlyArray<{ order_id: string; sku: string; qty: number }>;
		expect(lines).toHaveLength(2);
		const orders = (await runtime.database.query(
			'select id, customer from orders'
		)) as ReadonlyArray<{
			id: string;
		}>;
		// The children name the parent's guest-allocated id.
		expect(lines.every((line) => line.order_id === orders[0]?.id)).toBe(true);
		// One facility call: the commit transaction. A declared create with no transform reads nothing.
		expect(runtime.database.calls).toHaveLength(1);
		const history = (await runtime.database.query(
			`select record_id, operation from bolt_collection_history where collection_name in ('orders','order_lines')`
		)) as ReadonlyArray<{ operation: string }>;
		expect(history.filter((row) => row.operation === 'create')).toHaveLength(3);
	});

	it('refuses a custom value its declared type does not admit, and stores the open range it does', async () => {
		const runtime = await start();
		await expect(
			write(runtime, 'create', { customer: 'Ada', window: { start: '2026-01-01' } })
		).rejects.toThrow(/window is not a valid instant_range/);
		const commit = await write(runtime, 'create', {
			customer: 'Ada',
			window: { start: '2026-01-01T00:00:00.000Z', end: null }
		});
		expect(commit.batch.changes).toHaveLength(1);
	});

	it('never deletes by omission and applies explicit update, delete and unlink actions', async () => {
		const runtime = await start();
		await write(runtime, 'create', {
			customer: 'Ada',
			total: 30,
			order_lines: {
				create: [
					{ sku: 'A-1', qty: 1 },
					{ sku: 'B-2', qty: 2 },
					{ sku: 'C-3', qty: 3 }
				]
			}
		});
		const [first, second, third] = (await runtime.database.query(
			'select id, sku from order_lines order by sku'
		)) as ReadonlyArray<{ id: string; sku: string }>;

		// Only the named third is removed; a missing sibling is not an omission delete.
		await write(runtime, 'update', {
			id: (await runtime.database.query('select id from orders'))[0]?.['id'],
			total: 40,
			order_lines: {
				update: [{ id: first?.id, set: { qty: 10 } }],
				delete: [{ id: third?.id }]
			}
		});

		const rows = (await runtime.database.query(
			'select id, sku, qty, order_id from order_lines order by sku'
		)) as ReadonlyArray<{ id: string; sku: string; qty: number; order_id: string | null }>;
		expect(rows.map((row) => row.sku)).toEqual(['A-1', 'B-2']);
		expect(rows.find((row) => row.id === first?.id)?.qty).toBe(10);
		expect(rows.find((row) => row.id === second?.id)?.order_id).not.toBeNull();
	});

	it('refuses a field the declared input does not name, before anything is written', async () => {
		const runtime = await start();
		await expect(
			write(runtime, 'create', { customer: 'Ada', total: 30, forged: true })
		).rejects.toThrow(/forged/);
		expect(
			(await runtime.database.query('select count(*)::int as count from orders'))[0]?.['count']
		).toBe(0);
	});

	it('runs one transform per batch and commits what it returns', async () => {
		const runtime = await start(
			authored({
				collections: {
					orders: {
						...ordersWrite,
						transform: () =>
							Effect.succeed([
								{
									customer: 'Grace',
									total: 11,
									order_lines: { create: [{ sku: 'X-9', qty: 4 }] }
								}
							])
					},
					order_lines: linesWrite
				}
			})
		);
		await write(runtime, 'create', { customer: 'ignored' });
		const orders = (await runtime.database.query(
			'select customer, total from orders'
		)) as ReadonlyArray<{
			customer: string;
			total: number;
		}>;
		expect(orders).toEqual([{ customer: 'Grace', total: 11 }]);
		const lines = (await runtime.database.query('select sku from order_lines')) as ReadonlyArray<{
			sku: string;
		}>;
		expect(lines).toEqual([{ sku: 'X-9' }]);
	});

	it('upserts a related record by id: insert when absent, patch when present', async () => {
		const runtime = await start();
		const lineId = '018f9f89-6cb2-7b3c-8fc8-832ea10c46aa';
		await write(runtime, 'create', { customer: 'Ada', total: 1 });
		const orderId = (await runtime.database.query('select id from orders'))[0]?.['id'] as string;
		await write(runtime, 'update', {
			id: orderId,
			total: 1,
			order_lines: { upsert: [{ values: { id: lineId, sku: 'U-1', qty: 1 } }] }
		});
		expect(
			(await runtime.database.query('select sku, qty from order_lines')) as ReadonlyArray<{
				sku: string;
				qty: number;
			}>
		).toEqual([{ sku: 'U-1', qty: 1 }]);
		await write(runtime, 'update', {
			id: orderId,
			total: 2,
			order_lines: {
				upsert: [{ values: { id: lineId, sku: 'U-1', qty: 5 }, onConflictDoUpdate: { sku: 'U-1' } }]
			}
		});
		const lines = (await runtime.database.query(
			'select id, sku, qty from order_lines'
		)) as ReadonlyArray<{ id: string; sku: string; qty: number }>;
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ id: lineId, sku: 'U-1', qty: 5 });
	});

	it('composes a mixed declared graph into one statement per shape and one transaction', async () => {
		const runtime = await start();
		await write(runtime, 'create', {
			customer: 'A',
			order_lines: {
				create: [
					{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b1', sku: 'A-1', qty: 1 },
					{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b2', sku: 'A-2', qty: 2 }
				]
			}
		});
		await write(runtime, 'create', {
			customer: 'B',
			order_lines: { create: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b3', sku: 'B-3', qty: 3 }] }
		});
		const orders = (await runtime.database.query(
			'select id, customer from orders order by customer'
		)) as ReadonlyArray<{ id: string; customer: string }>;
		runtime.database.forget();
		await write(runtime, 'update', {
			id: orders[0]?.id,
			total: 9,
			order_lines: {
				update: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b1', set: { sku: 'A-1', qty: 4 } }],
				upsert: [
					{
						values: { id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b2', sku: 'A-2', qty: 2 },
						onConflictDoUpdate: { qty: 7 }
					}
				],
				delete: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b3' }]
			}
		});
		const statements = runtime.database.statements;
		// The whole graph is one statement: rows of one shape are one piece of it — the root update,
		// both child updates (same column set), and the child delete each appear once, whatever the
		// batch size. A write that read nothing takes no table lock.
		expect(statements.filter((sql) => sql.startsWith('lock table'))).toHaveLength(0);
		const folded = statements.filter((sql) => sql.includes('anchor as materialized'));
		expect(folded).toHaveLength(1);
		expect(folded[0]?.match(/update "orders" as t/g)).toHaveLength(1);
		expect(folded[0]?.match(/update "order_lines" as t/g)).toHaveLength(1);
		expect(folded[0]?.match(/delete from "order_lines" as t/g)).toHaveLength(1);
		// One read wave (the pre-image) plus one commit transaction: two facility calls.
		expect(runtime.database.calls).toHaveLength(2);
		const lines = (await runtime.database.query(
			'select id, qty from order_lines order by id'
		)) as ReadonlyArray<{ id: string; qty: number }>;
		expect(lines).toEqual([
			{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b1', qty: 4 },
			{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46b2', qty: 7 }
		]);
	});

	it('refuses a declared update whose observed row version moved, and admits the current one', async () => {
		const runtime = await start();
		await write(runtime, 'create', { customer: 'Ada', total: 30 });
		const [order] = (await runtime.database.query(
			'select id, row_version from orders'
		)) as ReadonlyArray<{
			id: string;
			row_version: number;
		}>;
		const version = order?.row_version ?? 0;
		await expect(
			write(runtime, 'update', { id: order?.id, total: 31 }, 'orders', [
				{ row: { collection: 'orders', recordId: order?.id ?? '' }, rowVersion: version + 1 }
			])
		).rejects.toThrow(/changed from row version/);
		expect((await runtime.database.query('select total from orders'))[0]?.['total']).toBe(30);
		await write(runtime, 'update', { id: order?.id, total: 31 }, 'orders', [
			{ row: { collection: 'orders', recordId: order?.id ?? '' }, rowVersion: version }
		]);
		expect((await runtime.database.query('select total from orders'))[0]?.['total']).toBe(31);
	});

	it('refuses a transform that reads past its second wave', async () => {
		const runtime = await start(
			authored({
				collections: {
					orders: {
						...ordersWrite,
						transform: (
							inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
							context: Readonly<{ db: unknown }>
						) => {
							const db = context.db as Readonly<{
								orders: Readonly<{ findMany: () => Effect.Effect<ReadonlyArray<unknown>> }>;
							}>;
							return Effect.gen(function* () {
								yield* db.orders.findMany();
								yield* db.orders.findMany();
								yield* db.orders.findMany();
								return inputs;
							});
						}
					},
					order_lines: linesWrite
				}
			})
		);
		await expect(write(runtime, 'create', { customer: 'Ada' })).rejects.toThrow(
			/exceeded its 2-wave read budget/
		);
		expect(
			(await runtime.database.query('select count(*)::int as count from orders'))[0]?.['count']
		).toBe(0);
	});

	it('links and unlinks related records as grouped updates', async () => {
		const runtime = await start();
		const lineId = '018f9f89-6cb2-7b3c-8fc8-832ea10c46c1';
		await write(runtime, 'create', {
			customer: 'A',
			order_lines: { create: [{ id: lineId, sku: 'A-1', qty: 1 }] }
		});
		await write(runtime, 'create', { customer: 'B' });
		const orders = (await runtime.database.query(
			'select id, customer from orders order by customer'
		)) as ReadonlyArray<{ id: string; customer: string }>;
		const target = orders.find((order) => order.customer === 'B')?.id;
		runtime.database.forget();

		await write(runtime, 'update', {
			id: target,
			total: 1,
			order_lines: { link: [{ id: lineId }] }
		});
		expect(
			(
				await runtime.database.query(`select order_id from order_lines where id = '${lineId}'`)
			)[0]?.['order_id']
		).toBe(target);

		runtime.database.forget();
		// `total` moves, or the root would be a value it already holds and no piece would write it.
		await write(runtime, 'update', {
			id: target,
			total: 2,
			order_lines: { unlink: [{ id: lineId }] }
		});
		expect(
			(
				await runtime.database.query(`select order_id from order_lines where id = '${lineId}'`)
			)[0]?.['order_id']
		).toBeNull();
		// The root patch and the child patch are one statement each, whatever the action's shape.
		const folded = runtime.database.statements.filter((sql) =>
			sql.includes('anchor as materialized')
		);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.match(/update "orders" as t/g)).toHaveLength(1);
		expect(folded[0]?.match(/update "order_lines" as t/g)).toHaveLength(1);
	});

	it('writes nothing for an update that restates every value the row already holds', async () => {
		const runtime = await start();
		await write(runtime, 'create', { customer: 'A', total: 5 });
		const before = (await runtime.database.query('select id, row_version from orders'))[0];
		runtime.database.forget();
		await write(runtime, 'update', { id: before?.['id'], total: 5 });
		const after = (await runtime.database.query('select id, row_version from orders'))[0];
		// Not assigned, not versioned, not revisioned: the row is exactly as it was.
		expect(after?.['row_version']).toBe(before?.['row_version']);
		const folded = runtime.database.statements.filter((sql) =>
			sql.includes('anchor as materialized')
		);
		expect(folded).toHaveLength(1);
		expect(folded[0]).not.toContain('update "orders"');
		expect(folded[0]).not.toContain('bolt_collection_history');
	});

	it('refuses a transform payload that leaves a required model field unset', async () => {
		const runtime = await start(
			authored({
				collections: {
					orders: { ...ordersWrite, transform: () => Effect.succeed([{ total: 5 }]) },
					order_lines: linesWrite
				}
			})
		);
		await expect(write(runtime, 'create', { customer: 'Ada' })).rejects.toThrow(
			/required field "customer"/
		);
		expect(
			(await runtime.database.query('select count(*)::int as count from orders'))[0]?.['count']
		).toBe(0);
	});

	it('hands a transform a read-only database surface with no writer to reach', async () => {
		let seen: Record<string, unknown> = {};
		const runtime = await start(
			authored({
				collections: {
					orders: {
						...ordersWrite,
						transform: (
							inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
							context: Readonly<{ db: unknown }>
						) => {
							seen = context.db as Record<string, unknown>;
							return Effect.succeed(inputs);
						}
					},
					order_lines: linesWrite
				}
			})
		);
		await write(runtime, 'create', { customer: 'Ada' });
		const writes = ['insert', 'update', 'delete', 'execute', 'transaction', 'mutate'] as const;
		for (const method of writes) expect(seen[method]).toBeUndefined();
		const orders = seen['orders'] as Record<string, unknown>;
		expect(orders['findMany']).toBeTypeOf('function');
		for (const method of writes) expect(orders[method]).toBeUndefined();
	});

	it('seeds collections in model order, keeps fixture ids, and re-runs as a no-op', async () => {
		const runtime = await start();
		const seed = (
			fixtures: ReadonlyArray<{ collection: string; rows: ReadonlyArray<Record<string, unknown>> }>
		) =>
			runtime.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.seedApply(EffectId.make('seed:1'), adminSubject, fixtures);
				})
			);
		// The child fixture is listed first on purpose: the plan is derived from the model graph.
		const first = await seed([
			{
				collection: 'order_lines',
				rows: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1', order_id: null, sku: 'S-1', qty: 1 }]
			},
			{
				collection: 'orders',
				rows: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d2', customer: 'Seeded', total: 10 }]
			}
		]);
		expect(first).toEqual({ orders: 1, order_lines: 1 });
		const rows = (await runtime.database.query(
			'select id, customer from orders union all select id, sku from order_lines order by 1'
		)) as ReadonlyArray<{ id: string }>;
		expect(rows.map((row) => row.id).toSorted()).toEqual([
			'018f9f89-6cb2-7b3c-8fc8-832ea10c46d1',
			'018f9f89-6cb2-7b3c-8fc8-832ea10c46d2'
		]);
		const second = await seed([
			{
				collection: 'orders',
				rows: [{ id: '018f9f89-6cb2-7b3c-8fc8-832ea10c46d2', customer: 'Seeded', total: 10 }]
			}
		]);
		expect(second).toEqual({ orders: 0 });
		expect(
			(await runtime.database.query('select count(*)::int as count from orders'))[0]?.['count']
		).toBe(1);
	});

	it('refuses a fixture for a collection with no declared create input', async () => {
		const runtime = await start();
		await expect(
			runtime.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.seedApply(EffectId.make('seed:2'), adminSubject, [
						{ collection: 'orders', rows: [] },
						{ collection: 'missing', rows: [{}] }
					]);
				})
			)
		).rejects.toThrow(/missing/);
	});

	it('enqueues the declared committed notification rules', async () => {
		const seen: Array<{ readonly channel: string; readonly recipient: string }> = [];
		const runtime = await start(
			authored({
				collections: {
					orders: {
						...ordersWrite,
						notifications: {
							committed: [
								{
									channel: 'inbox',
									recipients: () => ['ada'],
									message: () => ({ title: 'Order saved', body: 'It was saved.' })
								}
							]
						}
					},
					order_lines: linesWrite
				}
			})
		);
		await write(runtime, 'create', { customer: 'Ada' });
		const rows = (await runtime.database.query(
			'select recipient, payload from bolt_notifications'
		)) as ReadonlyArray<{ recipient: string; payload: Record<string, unknown> }>;
		expect(rows).toHaveLength(1);
		seen.push({
			channel: String(rows[0]?.payload['channel']),
			recipient: rows[0]?.recipient ?? ''
		});
		expect(seen).toEqual([{ channel: 'inbox', recipient: 'ada' }]);
	});

	it('resolves a team recipient to its members inside the write, once each', async () => {
		const runtime = await start(
			authored({
				collections: {
					orders: {
						...ordersWrite,
						notifications: {
							committed: [
								{
									channel: 'inbox',
									recipients: () => [{ team: 'HR Manager' }],
									message: () => ({ title: 'Order saved', body: 'A manager should look.' })
								}
							]
						}
					},
					order_lines: linesWrite
				}
			})
		);
		await runtime.database.query(
			`insert into "team" (id, name) values ('11111111-1111-4111-8111-111111111111', 'HR Manager'), ('22222222-2222-4222-8222-222222222222', 'Employee')`
		);
		await runtime.database.query(
			`insert into "user" (id, name, email, team_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Mia', 'mia@example.test', '11111111-1111-4111-8111-111111111111'), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Max', 'max@example.test', '11111111-1111-4111-8111-111111111111'), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Eve', 'eve@example.test', '22222222-2222-4222-8222-222222222222')`
		);
		await write(runtime, 'create', { customer: 'Ada' });
		const rows = (await runtime.database.query(
			'select recipient from bolt_notifications order by recipient'
		)) as ReadonlyArray<{ recipient: string }>;
		expect(rows.map((row) => row.recipient)).toEqual([
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
		]);
		// The row is written in the same statement as the record.
		const folded = runtime.database.statements.filter((sql) =>
			sql.includes('anchor as materialized')
		);
		expect(folded.at(-1)).toContain('insert into bolt_notifications');
	});
});
