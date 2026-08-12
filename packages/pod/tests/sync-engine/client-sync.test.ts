import { describe, it, expect, afterEach } from 'vitest';
import { createClientDb } from '../support/pglite-node.js';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import {
	enableClientSync,
	disableClientSync,
	localCount,
	localFindFirst,
	localFindMany,
	setLocalSchema,
	type LocalCollectionSchema,
	type LocalPage
} from '$lib/ui/sync/client-sync.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';

const SCHEMA = `CREATE TABLE customers (
	norbital_id text PRIMARY KEY,
	norbital_row_version integer,
	name text,
	region text
);
CREATE TABLE orders (
	norbital_id text PRIMARY KEY,
	norbital_row_version integer,
	status text,
	total integer,
	note text,
	customer_id text
);`;

/** The schema facts runtime/client.ts publishes from the manifest in the real app. */
function installSchema(): void {
	const schema = new Map<string, LocalCollectionSchema>([
		[
			'customers',
			{
				name: 'customers',
				columns: ['norbital_id', 'norbital_row_version', 'name', 'region'],
				fieldKinds: {
					norbital_id: 'string',
					norbital_row_version: 'number',
					name: 'string',
					region: 'string'
				},
				searchFields: ['name', 'region'],
				relationships: [
					{
						name: 'orders',
						target: 'orders',
						cardinality: 'many',
						localField: 'norbital_id',
						targetField: 'customer_id'
					}
				]
			}
		],
		[
			'orders',
			{
				name: 'orders',
				columns: ['norbital_id', 'norbital_row_version', 'status', 'total', 'note', 'customer_id'],
				fieldKinds: {
					norbital_id: 'string',
					norbital_row_version: 'number',
					status: 'string',
					total: 'number',
					note: 'string',
					customer_id: 'string'
				},
				searchFields: ['status', 'note'],
				relationships: [
					{
						name: 'customer',
						target: 'customers',
						cardinality: 'one',
						localField: 'customer_id',
						targetField: 'norbital_id'
					}
				]
			}
		]
	]);
	setLocalSchema(schema);
}

/** A `nextCursor` of null means the collection is fully fetched, so it becomes resident. */
const residentFetch: SyncFetch = async (path) => {
	if (path.startsWith('sync/shape')) {
		return new Response(JSON.stringify({ rows: [], nextCursor: null, watermark: '0' }), {
			headers: { 'content-type': 'application/json' }
		});
	}
	return new Response('{}', { headers: { 'content-type': 'application/json' } });
};

async function seededSync() {
	installSchema();
	const db = await createClientDb();
	const client = new PodSyncClient({
		replicaEpoch: 'test-epoch',
		db,
		schemaSql: SCHEMA,
		fetch: residentFetch
	});
	await client.bootstrap();

	await client.upsertRows('customers', [
		{ norbital_id: 'c1', norbital_row_version: 1, name: 'Acme', region: 'north' },
		{ norbital_id: 'c2', norbital_row_version: 1, name: 'Globex', region: 'south' }
	]);
	await client.upsertRows('orders', [
		{
			norbital_id: 'a',
			norbital_row_version: 1,
			status: 'open',
			total: 10,
			note: 'urgent',
			customer_id: 'c1'
		},
		{
			norbital_id: 'b',
			norbital_row_version: 1,
			status: 'open',
			total: 30,
			note: null,
			customer_id: 'c2'
		},
		{
			norbital_id: 'c',
			norbital_row_version: 1,
			status: 'closed',
			total: 20,
			note: 'later',
			customer_id: 'c1'
		}
	]);
	const sync = enableClientSync(client);
	await Promise.all(
		['customers', 'orders'].map((collection) => sync.registry.register(collection))
	);
	return { sync, client };
}

/**
 * The same data, but the server always reports another page waiting, so the catch-up runs out of
 * budget and both collections end up *windowed*. This is what a slice larger than the residency
 * cap looks like from the client's side, at any size.
 */
async function windowedSync(options: { warm?: boolean } = {}) {
	installSchema();
	const db = await createClientDb();
	let page = 0;
	const windowedFetch: SyncFetch = async (path) => {
		if (path.startsWith('sync/shape')) {
			// Always another page waiting, so the budget runs out before the data does.
			page += 1;
			return new Response(
				JSON.stringify({
					rows: [{ norbital_id: `w${page}`, norbital_row_version: 1 }],
					nextCursor: 'more',
					watermark: '0'
				}),
				{ headers: { 'content-type': 'application/json' } }
			);
		}
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	};
	const client = new PodSyncClient({
		replicaEpoch: 'test-epoch',
		db,
		schemaSql: SCHEMA,
		fetch: windowedFetch
	});
	await client.bootstrap();
	await client.upsertRows('customers', [
		{ norbital_id: 'c1', norbital_row_version: 1, name: 'Acme', region: 'north' }
	]);
	await client.upsertRows('orders', [
		{
			norbital_id: 'a',
			norbital_row_version: 1,
			status: 'open',
			total: 10,
			note: 'urgent',
			customer_id: 'c1'
		}
	]);
	const sync = enableClientSync(client, { residencyBytes: 1 });
	if (options.warm !== false) {
		await Promise.all(
			['customers', 'orders'].map((collection) => sync.registry.register(collection))
		);
	}
	return { sync, client };
}

afterEach(() => disableClientSync());

describe('client-sync local query executor', () => {
	it('filters by equality where and orders + limits', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', {
				where: { status: 'open' },
				orderBy: { total: 'desc' },
				limit: 5
			});
			expect(page).not.toBeNull();
			expect(page!.rows.map((r) => r.norbital_id)).toEqual(['b', 'a']);
		} finally {
			await client.close();
		}
	});

	it('supports operator conditions (gte / in)', async () => {
		const { sync, client } = await seededSync();
		try {
			const gte = await localFindMany(sync, 'orders', {
				where: { total: { gte: 20 } },
				orderBy: { total: 'asc' }
			});
			expect(gte!.rows.map((r) => r.norbital_id)).toEqual(['c', 'b']);

			const inList = await localFindMany(sync, 'orders', { where: { status: { in: ['closed'] } } });
			expect(inList!.rows.map((r) => r.norbital_id)).toEqual(['c']);
		} finally {
			await client.close();
		}
	});

	it('supports AND / OR / NOT and null operators', async () => {
		const { sync, client } = await seededSync();
		try {
			const either = await localFindMany(sync, 'orders', {
				where: { OR: [{ total: { lt: 15 } }, { status: 'closed' }] },
				orderBy: { norbital_id: 'asc' }
			});
			expect(either!.rows.map((r) => r.norbital_id)).toEqual(['a', 'c']);

			const missingNote = await localFindMany(sync, 'orders', {
				where: { note: { isNull: true } }
			});
			expect(missingNote!.rows.map((r) => r.norbital_id)).toEqual(['b']);

			const notClosed = await localFindMany(sync, 'orders', {
				where: { NOT: { status: 'closed' } },
				orderBy: { norbital_id: 'asc' }
			});
			expect(notClosed!.rows.map((r) => r.norbital_id)).toEqual(['a', 'b']);
		} finally {
			await client.close();
		}
	});

	it('findFirst returns the first match; count respects the filter', async () => {
		const { sync, client } = await seededSync();
		try {
			const first = await localFindFirst(sync, 'orders', { where: { norbital_id: 'c' } });
			expect(first && (first as { status: string }).status).toBe('closed');
			expect(await localCount(sync, 'orders', { where: { status: 'open' } })).toBe(2);
			expect(await localCount(sync, 'orders', {})).toBe(3);
		} finally {
			await client.close();
		}
	});

	it('applies interactive filters, which used to be silently ignored', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', {
				filters: [{ path: ['total'], operator: 'gte', operand: 20 }],
				orderBy: { total: 'asc' }
			});
			expect(page!.rows.map((r) => r.norbital_id)).toEqual(['c', 'b']);
			expect(
				await localCount(sync, 'orders', {
					filters: [{ path: ['status'], operator: 'eq', operand: 'open' }]
				})
			).toBe(2);
		} finally {
			await client.close();
		}
	});

	it('applies a filter across a relation path', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', {
				filters: [{ path: ['customer', 'region'], operator: 'eq', operand: 'north' }],
				orderBy: { norbital_id: 'asc' }
			});
			expect(page!.rows.map((r) => r.norbital_id)).toEqual(['a', 'c']);
		} finally {
			await client.close();
		}
	});

	it('resolves a to-one relation locally instead of falling back to the server', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', {
				with: { customer: true },
				orderBy: { norbital_id: 'asc' }
			});
			expect(page).not.toBeNull();
			expect(page!.rows.map((row) => (row.customer as { name: string } | null)?.name)).toEqual([
				'Acme',
				'Globex',
				'Acme'
			]);
		} finally {
			await client.close();
		}
	});

	it('resolves a to-many relation locally', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'customers', {
				with: { orders: true },
				orderBy: { norbital_id: 'asc' }
			});
			const counts = page!.rows.map((row) => (row.orders as unknown[]).length);
			expect(counts).toEqual([2, 1]);
		} finally {
			await client.close();
		}
	});

	it('hydrates nested relations recursively', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', {
				with: { customer: { columns: { name: true }, with: { orders: true } } },
				orderBy: { norbital_id: 'asc' }
			});
			const nestedOrderCounts = page!.rows.map(
				(row) => ((row.customer as { orders: unknown[] } | null)?.orders ?? []).length
			);
			expect(nestedOrderCounts).toEqual([2, 1, 2]);
		} finally {
			await client.close();
		}
	});

	it('searches locally across own fields and directly related records', async () => {
		const { sync, client } = await seededSync();
		try {
			const byOwnField = await localFindMany(sync, 'orders', { search: 'urgent' });
			expect(byOwnField!.rows.map((r) => r.norbital_id)).toEqual(['a']);

			// 'Globex' is a customer name, reached through the order's direct relation.
			const byRelation = await localFindMany(sync, 'orders', { search: 'Globex' });
			expect(byRelation!.rows.map((r) => r.norbital_id)).toEqual(['b']);
		} finally {
			await client.close();
		}
	});

	it('treats search wildcards as literal text', async () => {
		const { sync, client } = await seededSync();
		try {
			const page = await localFindMany(sync, 'orders', { search: '%' });
			expect(page!.rows).toEqual([]);
		} finally {
			await client.close();
		}
	});

	it('does not offer a next page when the last page exactly fills the limit', async () => {
		const { sync, client } = await seededSync();
		try {
			// 3 rows, page size 3: the page is full, but there is nothing after it.
			const exact = await localFindMany(sync, 'orders', {
				orderBy: { norbital_id: 'asc' },
				limit: 3
			});
			expect(exact!.rows.length).toBe(3);
			expect(exact!.nextCursor).toBeNull();

			const first = await localFindMany(sync, 'orders', {
				orderBy: { norbital_id: 'asc' },
				limit: 2
			});
			expect(first!.nextCursor).not.toBeNull();
			const second = await localFindMany(sync, 'orders', {
				orderBy: { norbital_id: 'asc' },
				limit: 2,
				after: first!.nextCursor
			});
			expect(second!.rows.map((r) => r.norbital_id)).toEqual(['c']);
			expect(second!.nextCursor).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('paginates ordered Unicode values through the browser cursor codec', async () => {
		const { sync, client } = await seededSync();
		try {
			await client.queryLocal(`DELETE FROM orders`);
			await client.upsertRows('orders', [
				{
					norbital_id: 'unicode-a',
					norbital_row_version: 1,
					status: 'PVC树脂 SG-5',
					total: 10,
					note: null,
					customer_id: 'c1'
				},
				{
					norbital_id: 'unicode-b',
					norbital_row_version: 1,
					status: '公斤',
					total: 20,
					note: null,
					customer_id: 'c1'
				}
			]);

			const first = await localFindMany(sync, 'orders', {
				orderBy: { status: 'asc' },
				limit: 1
			});
			expect(first!.nextCursor).not.toBeNull();

			const second = await localFindMany(sync, 'orders', {
				orderBy: { status: 'asc' },
				limit: 1,
				after: first!.nextCursor
			});
			expect(second!.nextCursor).toBeNull();
			expect(new Set([...first!.rows, ...second!.rows].map((row) => row.status))).toEqual(
				new Set(['PVC树脂 SG-5', '公斤'])
			);
		} finally {
			await client.close();
		}
	});

	it('paginates correctly when every row shares the sort value', async () => {
		const { sync, client } = await seededSync();
		try {
			// A freshly seeded table: every row shares the sort value, so the sort key alone does
			// not order them. Insert in reverse id order so the table's natural scan order
			// disagrees with the id order — that disagreement is what exposes the bug.
			//
			// The cursor is encoded against the *normalised* order (which appends norbital_id as a
			// tiebreaker), so the SQL must use that same order. Ordering by the raw `orderBy`
			// instead leaves the scan order free: page 1 hands back an arbitrary pair, and page 2's
			// keyset then re-serves a row already seen while dropping one entirely.
			await client.queryLocal(`DELETE FROM orders`);
			for (const id of ['z3', 'z2', 'z1']) {
				await client.upsertRow('orders', {
					norbital_id: id,
					norbital_row_version: 1,
					status: 'open',
					total: 10,
					customer_id: 'c1'
				});
			}

			const seen: unknown[] = [];
			let after: string | null = null;
			for (let page = 0; page < 5; page += 1) {
				const result: LocalPage | null = await localFindMany(sync, 'orders', {
					orderBy: { total: 'desc' },
					limit: 2,
					...(after ? { after } : {})
				});
				expect(result).not.toBeNull();
				seen.push(...result!.rows.map((r) => r.norbital_id));
				if (!result!.nextCursor) break;
				after = result!.nextCursor;
			}
			// Every row exactly once: no duplicate, no dropped row, no empty page in the middle.
			expect([...seen].sort()).toEqual(['z1', 'z2', 'z3']);
		} finally {
			await client.close();
		}
	});

	it('ignores `columns` locally and returns the complete row', async () => {
		const { sync, client } = await seededSync();
		try {
			// Projection keeps rows off the wire; there is no wire here, and the replica already
			// holds the whole row, so hiding fields would cost work and conceal nothing.
			const page = await localFindMany(sync, 'orders', {
				columns: { status: true },
				where: { norbital_id: 'a' }
			});
			expect(page!.rows[0]).toMatchObject({ norbital_id: 'a', status: 'open', total: 10 });
		} finally {
			await client.close();
		}
	});

	it('declines a query it cannot translate rather than answering it wrongly', async () => {
		const { sync, client } = await seededSync();
		try {
			expect(await localFindMany(sync, 'orders', { where: { status: { fuzzy: 'x' } } })).toBeNull();
			expect(await localFindMany(sync, 'orders', { with: { nonexistent: true } })).toBeNull();
		} finally {
			await client.close();
		}
	});
});

/**
 * A collection whose policy-scoped slice exceeds the residency budget. The replica holds a working
 * set, so the executor must answer locally only where a window cannot produce a *wrong* answer.
 * These are the cases where it must defer instead.
 */
describe('windowed collections (slice larger than the residency budget)', () => {
	it('is readable but never reports itself resident', async () => {
		const { sync, client } = await windowedSync({ warm: false });
		try {
			// A cold local read declines immediately so its authoritative server query is not held
			// behind a generic shape. The same read starts warming the collection in the background.
			expect(await localFindMany(sync, 'orders', { where: { norbital_id: 'a' } })).toBeNull();
			await sync.registry.register('orders');
			expect(sync.registry.has('orders')).toBe(true);
			expect(sync.registry.isResident('orders')).toBe(false);
		} finally {
			await client.close();
		}
	});

	it('answers a primary-key lookup locally even though the collection is windowed', async () => {
		const { sync, client } = await windowedSync();
		try {
			// `norbital_id` is unique, so a hit is the complete answer regardless of the window.
			// This is the read that opening a record and rendering relationship cells performs.
			const one = await localFindMany(sync, 'orders', { where: { norbital_id: 'a' } });
			expect(one!.rows.map((r) => r.norbital_id)).toEqual(['a']);
			expect(one!.nextCursor).toBeNull();

			const many = await localFindMany(sync, 'customers', {
				where: { norbital_id: { in: ['c1'] } }
			});
			expect(many!.rows.map((r) => r.norbital_id)).toEqual(['c1']);

			// A pinned key that is *not* local could still exist beyond the window — defer.
			expect(await localFindMany(sync, 'orders', { where: { norbital_id: 'absent' } })).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('sends search to the server, because a match may sit outside the window', async () => {
		const { sync, client } = await windowedSync();
		try {
			// 'urgent' *is* in the local window, and it still defers: the window cannot prove there
			// is no second match beyond it, and a partial result list is a wrong answer.
			expect(await localFindMany(sync, 'orders', { search: 'urgent' })).toBeNull();
			expect(await localFindMany(sync, 'orders', { search: 'nothing-local' })).toBeNull();
			expect(await localFindFirst(sync, 'orders', { search: 'urgent' })).toBeUndefined();
		} finally {
			await client.close();
		}
	});

	it('sends count to the server, because a count over a window is wrong not stale', async () => {
		const { sync, client } = await windowedSync();
		try {
			expect(await localCount(sync, 'orders', {})).toBeNull();
			expect(await localCount(sync, 'orders', { where: { status: 'open' } })).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('treats a findFirst miss as unknown rather than absence', async () => {
		const { sync, client } = await windowedSync();
		try {
			// Present locally → answered locally.
			const hit = await localFindFirst(sync, 'orders', { where: { norbital_id: 'a' } });
			expect(hit && (hit as { status: string }).status).toBe('open');
			// Absent locally → the row may still exist beyond the window, so ask the server.
			expect(
				await localFindFirst(sync, 'orders', { where: { norbital_id: 'zzz' } })
			).toBeUndefined();
		} finally {
			await client.close();
		}
	});

	it('defers every page of a windowed collection, however full it looks', async () => {
		const { sync, client } = await windowedSync();
		try {
			await client.upsertRows('orders', [
				{ norbital_id: 'b', norbital_row_version: 1, status: 'open', total: 20, customer_id: 'c1' },
				{ norbital_id: 'c', norbital_row_version: 1, status: 'open', total: 30, customer_id: 'c1' }
			]);

			// A full page used to be served locally on the theory that the window is a prefix of the
			// collection. It is — but only under the catch-up's own order and no filter. Under any
			// other sort, or any predicate, a matching row outside the window sorts into this page
			// and is silently absent from it, and the user cannot tell. The old code did not make
			// that distinction: it served a full page for every order and every filter.
			expect(
				await localFindMany(sync, 'orders', { orderBy: { norbital_id: 'asc' }, limit: 2 })
			).toBeNull();
			expect(
				await localFindMany(sync, 'orders', { orderBy: { total: 'desc' }, limit: 2 })
			).toBeNull();
			expect(
				await localFindMany(sync, 'orders', { where: { status: 'open' }, limit: 2 })
			).toBeNull();

			// A short page was already deferred — it may be the window's edge, not the end of data.
			expect(
				await localFindMany(sync, 'orders', { orderBy: { norbital_id: 'asc' }, limit: 50 })
			).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('still answers a pinned primary-key read from a window, which is what keeps it feeling local', async () => {
		const { sync, client } = await windowedSync();
		try {
			// `norbital_id` is unique, so a full set of hits is the complete answer no matter how much
			// of the collection is missing. Opening a record and filling relationship cells both look
			// like this, which is why the window is worth having at all.
			const pinned = await localFindMany(sync, 'orders', { where: { norbital_id: 'a' } });
			expect(pinned!.rows.map((r) => r.norbital_id)).toEqual(['a']);
			expect(pinned!.nextCursor).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('defers a to-many relation, and a to-one whose key is not local', async () => {
		const { sync, client } = await windowedSync();
		try {
			// The child set cannot be proven complete from a window.
			expect(await localFindMany(sync, 'customers', { with: { orders: true } })).toBeNull();

			// A to-one whose target row is local resolves locally...
			const resolved = await localFindMany(sync, 'orders', {
				with: { customer: true },
				where: { norbital_id: 'a' }
			});
			expect((resolved!.rows[0]!.customer as { name: string }).name).toBe('Acme');

			// ...but an unresolved key means the row is beyond the window, so defer.
			await client.upsertRow('orders', {
				norbital_id: 'd',
				norbital_row_version: 1,
				status: 'open',
				customer_id: 'not-local'
			});
			expect(await localFindMany(sync, 'orders', { with: { customer: true } })).toBeNull();
		} finally {
			await client.close();
		}
	});

	/**
	 * "No rows yet" and "no rows" are different answers and the UI renders them differently — a
	 * spinner versus an empty state. The replica can only tell them apart by whether it has ever
	 * finished a catch-up: `ready` is set on the FIRST page so reads can start immediately, so a
	 * collection mid-first-sync is readable and empty at the same time.
	 *
	 * Answering "empty" there is what makes a populated table render as "no records" while its data
	 * is still arriving. Declining instead sends the read to the server, and the query correctly
	 * reports itself as loading until a real answer exists.
	 */
	it('declines an empty answer until the collection has finished a catch-up once', async () => {
		installSchema();
		const db = await createClientDb();
		// Never resolves a page, so the catch-up starts but never completes: `ready` without
		// `synced`, which is exactly the first-load window.
		const stalledFetch: SyncFetch = async (path) => {
			if (path.startsWith('sync/shape')) {
				return new Response(JSON.stringify({ rows: [], nextCursor: 'more', watermark: '0' }), {
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		};
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: SCHEMA,
			fetch: stalledFetch
		});
		await client.bootstrap();
		const sync = enableClientSync(client);
		try {
			// Empty and not yet synced: no answer, so the caller asks the server.
			expect(await localFindMany(sync, 'customers', {})).toBeNull();
			await sync.registry.register('customers');
			expect(await localFindFirst(sync, 'customers', {})).toBeUndefined();
			expect(await localCount(sync, 'customers', {})).toBeNull();
			expect(sync.registry.has('customers')).toBe(true);
			expect(sync.registry.hasSynced('customers')).toBe(false);
		} finally {
			await client.close();
		}
	});

	it('answers an empty collection locally once it has genuinely synced', async () => {
		const { sync, client } = await seededSync();
		try {
			// `residentFetch` returns nextCursor:null, so the catch-up completes on page one.
			await sync.registry.register('customers');
			await client.queryLocal('DELETE FROM customers');
			expect(sync.registry.hasSynced('customers')).toBe(true);
			expect(await localFindMany(sync, 'customers', {})).toEqual({ rows: [], nextCursor: null });
			expect(await localCount(sync, 'customers', {})).toBe(0);
		} finally {
			await client.close();
		}
	});

	it('declines every restored answer until the document live-head barrier is crossed', async () => {
		installSchema();
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: SCHEMA,
			fetch: residentFetch
		});
		await client.bootstrap();
		await client.upsertRow('orders', {
			norbital_id: 'stale',
			norbital_row_version: 1,
			status: 'old'
		});
		await client.recordSyncState('orders', true, 1);
		const sync = enableClientSync(client);
		try {
			await sync.registry.restore();
			expect(await localFindMany(sync, 'orders', {})).toBeNull();
			expect(
				await localFindFirst(sync, 'orders', { where: { norbital_id: { eq: 'stale' } } })
			).toBeUndefined();
			expect(await localCount(sync, 'orders', {})).toBeNull();

			sync.registry.markRestoredFresh();
			expect(
				await localFindFirst(sync, 'orders', { where: { norbital_id: { eq: 'stale' } } })
			).toMatchObject({ norbital_id: 'stale', status: 'old' });
		} finally {
			await client.close();
		}
	});
});
