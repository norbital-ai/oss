import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import {
	type CollectionCatalog,
	CollectionMutationPendingApproval,
	createWorkspaceApiProxy
} from '../../src/client/runtime.js';
import { createLiveQueryRegistry } from '../../src/client/replica/live-queries.js';
import { ANY_COLLECTION, createQueryCache } from '../../src/client/replica/query-cache.js';

/**
 * What the declarative browser mutation sends, returns, and exposes while in flight.
 *
 * The transport is a stub because this suite owns the browser half only. The server suite owns the
 * atomic reconciliation behind `collections.mutate`.
 */
const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

type Sent = { readonly command: string; readonly input: unknown };

type CollectionWriter = {
	readonly mutate: (input: Record<string, unknown>) => Promise<void>;
	readonly pending: number;
};

/** A client whose transport records what it was asked to post and answers with `answer`. */
const clientAnswering = (answer: unknown) => {
	const sent: Array<Sent> = [];
	const bolt = createBoltClient(scope, {
		command: (command, input) => {
			sent.push({ command, input });
			return Promise.resolve(answer as never);
		}
	});
	const proxy = createWorkspaceApiProxy({ bolt, db: {} });
	const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;
	return { sent, orders };
};

/** One row as the database holds it: the columns posted plus the ones only it can fill. */
const storedOrder = {
	id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00',
	reference: 'ORD-1-normalised',
	status: 'draft',
	row_version: 1,
	created_at: '2026-08-20T00:00:00.000Z'
};

const deferred = () => {
	let resolve: (value: unknown) => void = () => undefined;
	let reject: (cause: unknown) => void = () => undefined;
	const promise = new Promise<unknown>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
};

describe('a declarative collection mutation from the browser', () => {
	it('posts the complete graph through the one mutation command', async () => {
		const { sent, orders } = clientAnswering({ records: [storedOrder] });
		const values = {
			id: storedOrder.id,
			reference: 'ORD-1',
			order_line_order: [
				{ id: 'line-1', sku: 'a-1' },
				{ sku: 'a-2', components: [] }
			]
		};

		await orders.mutate(values);

		expect(sent).toEqual([
			{ command: 'collections.mutate', input: { collection: 'orders', values } }
		]);
	});

	it('resolves without exposing a stored row', async () => {
		const { orders } = clientAnswering({ records: [storedOrder] });

		const result = await orders.mutate({ reference: 'ORD-1' });

		expect(result).toBeUndefined();
	});

	it('does not require readback from a write-only collection', async () => {
		const { orders } = clientAnswering({ records: [] });

		await expect(orders.mutate({ reference: 'ORD-1' })).resolves.toBeUndefined();
	});

	it('invalidates readable queries after a write-only success', async () => {
		const cache = createQueryCache('write-only-success-test');
		await Effect.runPromise(cache.hydrated);
		cache.write('orders', [storedOrder], ['orders']);
		cache.write('customers', [], ['customers']);

		const queries = createLiveQueryRegistry();
		let refreshRoot = 0;
		const rootQuery = {
			collections: ['orders'],
			refresh: () => {
				refreshRoot += 1;
				return Promise.resolve();
			}
		};
		queries.register(rootQuery);

		const bolt = createBoltClient(scope, {
			command: () => Promise.resolve({ records: [] } as never)
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		await orders.mutate({ reference: 'ORD-1' });
		await vi.waitFor(() => expect(refreshRoot).toBe(1));

		expect(await Effect.runPromise(cache.read('orders'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('customers'))).toEqual([]);
		expect(orders.pending).toBe(0);
	});

	it('clearing a relationship invalidates cascade-reachable descendants', async () => {
		const cache = createQueryCache('cascade-clear-test');
		await Effect.runPromise(cache.hydrated);
		cache.write('order-lines', [], ['order_lines']);
		cache.write('components', [], ['components']);
		cache.write('line-notes', [], ['line_notes']);

		const catalog: CollectionCatalog = {
			orders: {
				name: 'orders',
				fields: [],
				relationships: [
					{
						name: 'order_line_order',
						target: 'order_lines',
						cardinality: 'many',
						cascade: true
					}
				]
			},
			order_lines: {
				name: 'order_lines',
				fields: [],
				relationships: [
					{
						name: 'component_line',
						target: 'components',
						cardinality: 'many',
						cascade: true
					},
					{
						name: 'note_line',
						target: 'line_notes',
						cardinality: 'many'
					}
				]
			},
			components: { name: 'components', fields: [], relationships: [] },
			line_notes: { name: 'line_notes', fields: [], relationships: [] }
		};

		const queries = createLiveQueryRegistry();
		let refreshLines = 0;
		let refreshComponents = 0;
		let refreshNotes = 0;
		const lineQuery = {
			collections: ['order_lines'],
			refresh: () => {
				refreshLines += 1;
				return Promise.resolve();
			}
		};
		const componentQuery = {
			collections: ['components'],
			refresh: () => {
				refreshComponents += 1;
				return Promise.resolve();
			}
		};
		const noteQuery = {
			collections: ['line_notes'],
			refresh: () => {
				refreshNotes += 1;
				return Promise.resolve();
			}
		};
		queries.register(lineQuery);
		queries.register(componentQuery);
		queries.register(noteQuery);

		const bolt = createBoltClient(scope, {
			command: () => Promise.resolve({ records: [] } as never)
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries }, catalog);
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		await orders.mutate({ id: storedOrder.id, order_line_order: [] });
		await vi.waitFor(() => {
			expect(refreshLines).toBe(1);
			expect(refreshComponents).toBe(1);
		});

		expect(await Effect.runPromise(cache.read('order-lines'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('components'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('line-notes'))).toEqual([]);
		expect(refreshNotes).toBe(0);
		expect(orders.pending).toBe(0);
	});

	it('surfaces HTTP 202 as a precise pending-approval rejection', async () => {
		const outcome = {
			pending: true,
			requestId: 'approval-1',
			collection: 'orders',
			id: storedOrder.id,
			action: 'update'
		};
		const { orders } = clientAnswering(outcome);

		const failure = await orders
			.mutate({ id: storedOrder.id, reference: 'ORD-2' })
			.catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(CollectionMutationPendingApproval);
		expect(failure).toMatchObject(outcome);
		expect(orders.pending).toBe(0);
	});

	it('invalidates root and approval readers before surfacing HTTP 202', async () => {
		const outcome = {
			pending: true,
			requestId: 'approval-1',
			collection: 'orders',
			id: storedOrder.id,
			action: 'update'
		} as const;
		const cache = createQueryCache('pending-approval-test');
		await Effect.runPromise(cache.hydrated);
		cache.write('orders', [storedOrder], ['orders']);
		cache.write('approval-status', outcome, [ANY_COLLECTION]);
		cache.write('customers', [], ['customers']);

		const queries = createLiveQueryRegistry();
		let refreshRoot = 0;
		let refreshApproval = 0;
		let refreshUnrelated = 0;
		const rootQuery = {
			collections: ['orders'],
			refresh: () => {
				refreshRoot += 1;
				return Promise.resolve();
			}
		};
		const approvalQuery = {
			collections: [ANY_COLLECTION],
			refresh: () => {
				refreshApproval += 1;
				return Promise.resolve();
			}
		};
		const unrelatedQuery = {
			collections: ['customers'],
			refresh: () => {
				refreshUnrelated += 1;
				return Promise.resolve();
			}
		};
		queries.register(rootQuery);
		queries.register(approvalQuery);
		queries.register(unrelatedQuery);

		const bolt = createBoltClient(scope, {
			command: () => Promise.resolve(outcome as never)
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		await expect(orders.mutate({ id: storedOrder.id, reference: 'ORD-2' })).rejects.toBeInstanceOf(
			CollectionMutationPendingApproval
		);
		await vi.waitFor(() => {
			expect(refreshRoot).toBe(1);
			expect(refreshApproval).toBe(1);
		});

		expect(await Effect.runPromise(cache.read('orders'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('approval-status'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('customers'))).toEqual([]);
		expect(refreshUnrelated).toBe(0);
		expect(orders.pending).toBe(0);
	});

	it('does not expose browser create, update, or delete operations', () => {
		const { orders } = clientAnswering({ records: [storedOrder] });

		expect(orders).not.toHaveProperty('create');
		expect(orders).not.toHaveProperty('update');
		expect(orders).not.toHaveProperty('delete');
	});

	it('counts concurrent writes until each one settles', async () => {
		const first = deferred();
		const second = deferred();
		const responses = [first, second];
		const bolt = createBoltClient(scope, {
			command: () => responses.shift()?.promise as Promise<never>
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		const one = orders.mutate({ reference: 'ORD-1' });
		const two = orders.mutate({ reference: 'ORD-2' });
		expect(orders.pending).toBe(2);

		first.resolve({ records: [storedOrder] });
		await one;
		expect(orders.pending).toBe(1);

		second.resolve({ records: [{ ...storedOrder, id: 'order-2' }] });
		await two;
		expect(orders.pending).toBe(0);
	});

	it('settles pending when the transport rejects', async () => {
		const held = deferred();
		const bolt = createBoltClient(scope, { command: () => held.promise as Promise<never> });
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		const write = orders.mutate({ reference: 'ORD-1' });
		expect(orders.pending).toBe(1);
		held.reject(new Error('offline'));
		await expect(write).rejects.toThrow();
		expect(orders.pending).toBe(0);
	});

	it('invalidates readers when a committed mutation rejects while settling', async () => {
		const cache = createQueryCache('committed-settle-failure-test');
		await Effect.runPromise(cache.hydrated);
		cache.write('orders', [storedOrder], ['orders']);
		cache.write('customers', [], ['customers']);

		const queries = createLiveQueryRegistry();
		let refreshRoot = 0;
		const rootQuery = {
			collections: ['orders'],
			refresh: () => {
				refreshRoot += 1;
				return Promise.resolve();
			}
		};
		queries.register(rootQuery);

		const bolt = createBoltClient(scope, {
			command: () => Promise.reject(new Error('after hook failed after commit'))
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });
		const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;

		await expect(orders.mutate({ id: storedOrder.id, reference: 'ORD-2' })).rejects.toBeDefined();
		await vi.waitFor(() => expect(refreshRoot).toBe(1));

		expect(await Effect.runPromise(cache.read('orders'))).toBeUndefined();
		expect(await Effect.runPromise(cache.read('customers'))).toEqual([]);
		expect(orders.pending).toBe(0);
	});
});
