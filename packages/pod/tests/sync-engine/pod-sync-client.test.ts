import { describe, it, expect } from 'vitest';
import { createClientDb } from '../support/pglite-node.js';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch, MutateResponse, ShapeResponse, SyncDiff } from '$lib/ui/sync/types.js';

const SCHEMA = `CREATE TABLE orders (
	norbital_id text PRIMARY KEY,
	norbital_row_version integer,
	status text
);`;

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function sseResponse(diffs: SyncDiff[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const diff of diffs)
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(diff)}\n\n`));
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockTransport(handlers: {
	shape?: (body: {
		collection: string;
		cursor?: string | null;
		pageSize?: number;
	}) => ShapeResponse;
	mutate?: (body: { mutations: unknown[] }) => MutateResponse;
	stream?: () => SyncDiff[];
}): { fetch: SyncFetch; calls: string[] } {
	const calls: string[] = [];
	const fetch: SyncFetch = async (path, init) => {
		calls.push(path);
		const body = init.body ? JSON.parse(init.body) : {};
		if (path.startsWith('sync/shape')) {
			return jsonResponse(handlers.shape?.(body) ?? { rows: [], nextCursor: null, watermark: '0' });
		}
		if (path.startsWith('sync/mutate')) {
			return jsonResponse(handlers.mutate?.(body) ?? { results: [] });
		}
		if (path.startsWith('sync/stream')) {
			return sseResponse(handlers.stream?.() ?? []);
		}
		return new Response('not found', { status: 404 });
	};
	return { fetch, calls };
}

async function makeClient(fetch: SyncFetch): Promise<PodSyncClient> {
	const db = await createClientDb();
	const client = new PodSyncClient({ replicaEpoch: 'test-epoch', db, schemaSql: SCHEMA, fetch });
	await client.bootstrap();
	return client;
}

function shapePage(
	rows: Record<string, unknown>[],
	overrides: Partial<ShapeResponse> = {}
): ShapeResponse {
	return { rows, nextCursor: null, watermark: '0', ...overrides };
}

describe('PodSyncClient (client sync logic)', () => {
	it('materialises a shape page and advances the cursor', async () => {
		const { fetch, calls } = mockTransport({
			shape: () =>
				shapePage(
					[
						{ norbital_id: 'a', norbital_row_version: 1, status: 'open' },
						{ norbital_id: 'b', norbital_row_version: 1, status: 'closed' }
					],
					{ watermark: '5' }
				)
		});
		const client = await makeClient(fetch);
		try {
			const page = await client.shapeSubscribe({ collection: 'orders' });
			// A null nextCursor is the entire "that was the last page" signal.
			expect(page.nextCursor).toBeNull();
			expect(await client.count('orders')).toBe(2);
			const row = await client.queryLocal<{ status: string }>(
				`SELECT status FROM orders WHERE norbital_id = 'a'`
			);
			expect(row[0]?.status).toBe('open');
			expect(calls.length).toBe(1);
		} finally {
			await client.close();
		}
	});

	it('pages through a collection until the cursor runs out', async () => {
		let pageNum = 0;
		const { fetch, calls } = mockTransport({
			shape: () => {
				pageNum += 1;
				return pageNum === 1
					? shapePage([{ norbital_id: 'a', norbital_row_version: 1, status: 'first' }], {
							nextCursor: 'cursor-1'
						})
					: shapePage([{ norbital_id: 'b', norbital_row_version: 1, status: 'second' }]);
			}
		});
		const client = await makeClient(fetch);
		try {
			const p1 = await client.shapeSubscribe({ collection: 'orders' });
			expect(p1.nextCursor).toBe('cursor-1');
			expect(await client.count('orders')).toBe(1);

			const p2 = await client.shapeSubscribe({ collection: 'orders', cursor: 'cursor-1' });
			expect(p2.nextCursor).toBeNull();
			expect(await client.count('orders')).toBe(2);
			expect(calls.length).toBe(2);
		} finally {
			await client.close();
		}
	});

	it('applies confirmed create/update/delete mutations locally', async () => {
		const { fetch } = mockTransport({
			mutate: (body) => ({
				results: (
					body.mutations as { clientId: string; action: string; row?: Record<string, unknown> }[]
				).map((m) => ({
					clientId: m.clientId,
					status: 'confirmed' as const,
					serverId: (m.row?.norbital_id as string) ?? null,
					row: m.action === 'delete' ? undefined : { ...m.row, norbital_row_version: 1 }
				}))
			})
		});
		const client = await makeClient(fetch);
		try {
			await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'x', status: 'open' }
				}
			]);
			expect(await client.count('orders')).toBe(1);
			await client.mutate([
				{
					clientId: 'c2',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'x', status: 'closed' },
					version: 1
				}
			]);
			const row = await client.queryLocal<{ status: string }>(
				`SELECT status FROM orders WHERE norbital_id='x'`
			);
			expect(row[0]?.status).toBe('closed');
			await client.mutate([
				{ clientId: 'c3', collection: 'orders', action: 'delete', row: { norbital_id: 'x' } }
			]);
			expect(await client.count('orders')).toBe(0);
		} finally {
			await client.close();
		}
	});

	it('surfaces a version CONFLICT without mutating the local replica', async () => {
		const current = { norbital_id: 'x', norbital_row_version: 7, status: 'server-wins' };
		const { fetch } = mockTransport({
			mutate: (body) => ({
				results: (body.mutations as { clientId: string }[]).map((m) => ({
					clientId: m.clientId,
					status: 'rejected' as const,
					reason: 'CONFLICT',
					currentRow: current
				}))
			})
		});
		const client = await makeClient(fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'x',
				norbital_row_version: 1,
				status: 'local'
			});
			const results = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'x', status: 'stale' },
					version: 1
				}
			]);
			expect(results[0]?.status).toBe('rejected');
			expect((results[0] as { reason: string }).reason).toBe('CONFLICT');
			expect((results[0] as unknown as { currentRow: { status: string } }).currentRow.status).toBe(
				'server-wins'
			);
			const row = await client.queryLocal<{ status: string }>(
				`SELECT status FROM orders WHERE norbital_id='x'`
			);
			expect(row[0]?.status).toBe('local');
		} finally {
			await client.close();
		}
	});

	it('queues writes while offline and flushes them on reconnect', async () => {
		let mutateCalls = 0;
		const { fetch } = mockTransport({
			mutate: (body) => {
				mutateCalls += 1;
				return {
					results: (body.mutations as { clientId: string; row?: Record<string, unknown> }[]).map(
						(m) => ({
							clientId: m.clientId,
							status: 'confirmed' as const,
							serverId: (m.row?.norbital_id as string) ?? null,
							row: { ...m.row, norbital_row_version: 1 }
						})
					)
				};
			}
		});
		const client = await makeClient(fetch);
		try {
			client.setOnline(false);
			const offline = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'q', status: 'queued' }
				}
			]);
			expect(offline[0]?.status).toBe('rejected');
			expect((offline[0] as { reason: string }).reason).toBe('OFFLINE_QUEUED');
			expect(mutateCalls).toBe(0);
			const pending = await client.queryLocal(`SELECT client_id FROM _pod_pending`);
			expect(pending.length).toBe(1);

			client.setOnline(true);
			const flushed = await client.flushPending();
			expect(flushed[0]?.status).toBe('confirmed');
			expect(mutateCalls).toBe(1);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
			expect(await client.count('orders')).toBe(1);
		} finally {
			await client.close();
		}
	});

	/**
	 * `isOnline()` was `navigator.onLine && this.online`, and nothing ever assigned `this.online` —
	 * so the whole verdict was `navigator.onLine`, which reports whether the machine has a network
	 * interface, not whether our server can be reached. A Wi-Fi handover or a VPN reconnect flips it
	 * false for a moment, and any write landing in that window was filed as "offline queued" while
	 * the server was answering every other request perfectly well.
	 */
	it('stays online while requests succeed, whatever the browser claims', async () => {
		let mutateCalls = 0;
		const { fetch } = mockTransport({
			mutate: (body) => {
				mutateCalls += 1;
				return {
					results: (body.mutations as { clientId: string; row?: Record<string, unknown> }[]).map(
						(m) => ({
							clientId: m.clientId,
							status: 'confirmed' as const,
							serverId: (m.row?.norbital_id as string) ?? null,
							row: { ...m.row, norbital_row_version: 1 }
						})
					)
				};
			}
		});
		const client = await makeClient(fetch);
		const original = Reflect.get(globalThis, 'navigator');
		Object.defineProperty(globalThis, 'navigator', {
			value: { onLine: false },
			configurable: true,
			writable: true
		});
		try {
			expect(client.isOnline()).toBe(true);
			const results = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'r', status: 'open' }
				}
			]);
			expect(results[0]?.status).toBe('confirmed');
			expect(mutateCalls).toBe(1);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
		} finally {
			if (original === undefined) Reflect.deleteProperty(globalThis, 'navigator');
			else
				Object.defineProperty(globalThis, 'navigator', {
					value: original,
					configurable: true,
					writable: true
				});
			await client.close();
		}
	});

	/** A gateway with no healthy upstream is the real offline signal, and recovery has to drain. */
	it('marks itself offline on a 503 and drains once the server answers again', async () => {
		let reachable = false;
		let mutateCalls = 0;
		const fetch: SyncFetch = async (path, init) => {
			if (!path.startsWith('sync/mutate')) return new Response('not found', { status: 404 });
			mutateCalls += 1;
			if (!reachable) return new Response('no upstream', { status: 503 });
			const body = JSON.parse(init.body!) as {
				mutations: { clientId: string; row?: Record<string, unknown> }[];
			};
			return jsonResponse({
				results: body.mutations.map((m) => ({
					clientId: m.clientId,
					status: 'confirmed' as const,
					serverId: (m.row?.norbital_id as string) ?? null,
					row: { ...m.row, norbital_row_version: 1 }
				}))
			});
		};
		const client = await makeClient(fetch);
		try {
			const queued = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'q', status: 'queued' }
				}
			]);
			expect(queued[0]?.status).toBe('rejected');
			expect((queued[0] as { reason: string }).reason).toBe('OFFLINE_QUEUED');
			expect(client.isOnline()).toBe(false);
			// The optimistic row is on screen even though the write has not landed.
			expect(await client.count('orders')).toBe(1);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(1);

			reachable = true;
			const flushed = await client.flushPending();
			expect(flushed[0]?.status).toBe('confirmed');
			expect(client.isOnline()).toBe(true);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
			expect(mutateCalls).toBe(2);
		} finally {
			await client.close();
		}
	});

	it('rejects an HTTP 500 mutate without queuing or going offline', async () => {
		const fetch: SyncFetch = async (path) => {
			if (!path.startsWith('sync/mutate')) return new Response('not found', { status: 404 });
			return new Response(JSON.stringify({ error: 'Internal Error' }), {
				status: 500,
				headers: { 'content-type': 'application/json' }
			});
		};
		const client = await makeClient(fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'x',
				norbital_row_version: 1,
				status: 'open'
			});
			const results = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'x', status: 'closed' },
					version: 1
				}
			]);
			expect(results[0]?.status).toBe('rejected');
			expect((results[0] as { reason: string }).reason).not.toBe('OFFLINE_QUEUED');
			expect((results[0] as { reason: string }).reason).toMatch(/500/);
			expect(client.isOnline()).toBe(true);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
			expect((await client.localRow('orders', 'x'))?.status).toBe('open');
		} finally {
			await client.close();
		}
	});

	/**
	 * Deleting a record whose create is still queued used to send the delete straight to the server,
	 * which had never seen the id and answered `404 Record with ID … not found`. It self-resolved
	 * once the outbox drained, so it was a race — and one the client can remove outright, because
	 * the create is still in its own hands. Create-then-delete on an unsynced row is a no-op.
	 */
	it('cancels a delete against a create that has not been sent, without a round trip', async () => {
		let mutateCalls = 0;
		const { fetch } = mockTransport({
			mutate: () => {
				mutateCalls += 1;
				return { results: [] };
			}
		});
		const client = await makeClient(fetch);
		try {
			client.setOnline(false);
			await client.mutate([
				{
					clientId: 'create-1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'ghost', status: 'draft' }
				}
			]);
			expect(await client.count('orders')).toBe(1);

			const deleted = await client.mutate([
				{
					clientId: 'delete-1',
					collection: 'orders',
					action: 'delete',
					row: { norbital_id: 'ghost' }
				}
			]);
			expect(deleted[0]?.status).toBe('confirmed');
			expect(await client.count('orders')).toBe(0);
			// Both halves left the outbox: nothing remains to be sent about a record that never existed.
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);

			// And the drain has nothing to say either — the server is never told about it at all.
			client.setOnline(true);
			await client.flushPending();
			expect(mutateCalls).toBe(0);
		} finally {
			await client.close();
		}
	});

	it('folds an update into the create it is still waiting behind', async () => {
		let sent: { action: string; row?: Record<string, unknown> }[] = [];
		const { fetch } = mockTransport({
			mutate: (body) => {
				sent = body.mutations as { action: string; row?: Record<string, unknown> }[];
				return {
					results: (body.mutations as { clientId: string; row?: Record<string, unknown> }[]).map(
						(m) => ({
							clientId: m.clientId,
							status: 'confirmed' as const,
							serverId: (m.row?.norbital_id as string) ?? null,
							row: { ...m.row, norbital_row_version: 1 }
						})
					)
				};
			}
		});
		const client = await makeClient(fetch);
		try {
			client.setOnline(false);
			await client.mutate([
				{
					clientId: 'create-1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'k', status: 'draft' }
				}
			]);
			await client.mutate([
				{
					clientId: 'update-1',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'k', status: 'final' }
				}
			]);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(1);

			client.setOnline(true);
			await client.flushPending();
			// One INSERT carrying the latest values — never an UPDATE racing ahead of its own row.
			expect(sent).toHaveLength(1);
			expect(sent[0]?.action).toBe('create');
			expect(sent[0]?.row?.status).toBe('final');
			expect((await client.localRow('orders', 'k'))?.status).toBe('final');
		} finally {
			await client.close();
		}
	});

	/**
	 * Offline queueing and dependent ordering happening at once. The server is unreachable, so an
	 * update queues; a second update to the same record must then queue *behind* it rather than
	 * race it; an unrelated create joins the same queue. When the server comes back, one drain
	 * sends all three, oldest first, and each reaches the server exactly once.
	 */
	it('drains an offline queue with dependent entries in order, exactly once, on reconnect', async () => {
		let reachable = false;
		let mutateCalls = 0;
		const batches: { clientId: string; action: string; row?: Record<string, unknown> }[][] = [];
		const fetch: SyncFetch = async (path, init) => {
			if (!path.startsWith('sync/mutate')) return new Response('not found', { status: 404 });
			mutateCalls += 1;
			if (!reachable) return new Response('no upstream', { status: 503 });
			const body = JSON.parse(init.body!) as {
				mutations: { clientId: string; action: string; row?: Record<string, unknown> }[];
			};
			batches.push(body.mutations);
			return jsonResponse({
				results: body.mutations.map((m) => ({
					clientId: m.clientId,
					status: 'confirmed' as const,
					serverId: (m.row?.norbital_id as string) ?? null,
					row: { ...m.row, norbital_row_version: 2 }
				}))
			});
		};
		const client = await makeClient(fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'a',
				norbital_row_version: 1,
				status: 'open'
			});

			// The first write discovers the outage the honest way — by failing to reach the server.
			const first = await client.mutate([
				{
					clientId: 'update-1',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'a', status: 'one' },
					version: 1
				}
			]);
			expect(first[0]).toMatchObject({ status: 'rejected', reason: 'OFFLINE_QUEUED' });
			expect(client.isOnline()).toBe(false);
			expect(mutateCalls).toBe(1);

			// Dependent ordering: this edit's server-side effect depends on the queued one, so it
			// must not be sent first. It is appended to the outbox without any round trip at all.
			const second = await client.mutate([
				{
					clientId: 'update-2',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'a', status: 'two' },
					version: 1
				}
			]);
			expect(second[0]).toMatchObject({ status: 'rejected', reason: 'OFFLINE_QUEUED' });
			expect(mutateCalls).toBe(1);

			// An unrelated write queues on the same clock, interleaved behind both.
			const third = await client.mutate([
				{
					clientId: 'create-1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'b', status: 'new' }
				}
			]);
			expect(third[0]).toMatchObject({ status: 'rejected', reason: 'OFFLINE_QUEUED' });
			expect(mutateCalls).toBe(1);
			expect(
				(
					await client.queryLocal<{ client_id: string }>(
						`SELECT client_id FROM _pod_pending ORDER BY created_at ASC`
					)
				).map((entry) => entry.client_id)
			).toEqual(['update-1', 'update-2', 'create-1']);

			// Connectivity returns; the drain it triggers sends everything once, in queue order.
			reachable = true;
			client.setOnline(true);
			const flushed = await client.flushPending();
			expect(flushed.every((result) => result.status === 'confirmed')).toBe(true);
			expect(batches).toHaveLength(1);
			expect(batches[0]!.map((mutation) => mutation.clientId)).toEqual([
				'update-1',
				'update-2',
				'create-1'
			]);
			// The failed probe plus the one successful drain — every entry reached the server once.
			expect(mutateCalls).toBe(2);
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
			expect((await client.localRow('orders', 'a'))?.status).toBe('two');
			expect((await client.localRow('orders', 'b'))?.status).toBe('new');

			// And the outbox stays empty: nothing re-sends on a second pass.
			await client.flushPending();
			expect(mutateCalls).toBe(2);
		} finally {
			await client.close();
		}
	});

	/**
	 * The device's own connectivity events are wired where a window exists. `offline` is trusted
	 * negatively — a write queues without spending a request on proving the radio is down — and
	 * `online` is the drain trigger: the outbox moves the moment the device says it can, and the
	 * attempt itself decides the verdict.
	 */
	it('queues on the browser offline event and drains on the online event', async () => {
		const listeners = new Map<string, Set<() => void>>();
		const fakeWindow = {
			addEventListener: (type: string, listener: () => void) => {
				const set = listeners.get(type) ?? new Set<() => void>();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener: (type: string, listener: () => void) => {
				listeners.get(type)?.delete(listener);
			}
		};
		// The replica must open before the fake window exists: PGlite picks its loader by sniffing
		// `window`, and a client db that believes it is in a browser it cannot find never opens.
		const db = await createClientDb();
		let mutateCalls = 0;
		const { fetch } = mockTransport({
			mutate: (body) => {
				mutateCalls += 1;
				return {
					results: (body.mutations as { clientId: string; row?: Record<string, unknown> }[]).map(
						(m) => ({
							clientId: m.clientId,
							status: 'confirmed' as const,
							serverId: (m.row?.norbital_id as string) ?? null,
							row: { ...m.row, norbital_row_version: 1 }
						})
					)
				};
			}
		});
		const hadWindow = Reflect.has(globalThis, 'window');
		const original = Reflect.get(globalThis, 'window');
		Reflect.set(globalThis, 'window', fakeWindow);
		let client: PodSyncClient | undefined;
		try {
			client = new PodSyncClient({ replicaEpoch: 'test-epoch', db, schemaSql: SCHEMA, fetch });
			await client.bootstrap();
			expect(listeners.get('offline')?.size).toBe(1);
			expect(listeners.get('online')?.size).toBe(1);

			for (const listener of listeners.get('offline') ?? []) listener();
			expect(client.isOnline()).toBe(false);

			const queued = await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'w', status: 'queued' }
				}
			]);
			expect(queued[0]).toMatchObject({ status: 'rejected', reason: 'OFFLINE_QUEUED' });
			// The radio being down is not a request: nothing was sent to find that out.
			expect(mutateCalls).toBe(0);

			for (const listener of listeners.get('online') ?? []) listener();
			// The online event schedules the drain; it is not awaited anywhere, so poll for it.
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length === 0) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect((await client.queryLocal(`SELECT client_id FROM _pod_pending`)).length).toBe(0);
			expect(mutateCalls).toBe(1);
			expect(client.isOnline()).toBe(true);
		} finally {
			if (hadWindow) Reflect.set(globalThis, 'window', original);
			else Reflect.deleteProperty(globalThis, 'window');
			await client?.close();
		}
	});

	/** The coalescing must not swallow a real delete: an id the outbox knows nothing about is the
	 *  server's to judge, and it is still entitled to answer 404. */
	it('sends a delete for a record the outbox has never heard of', async () => {
		let mutateCalls = 0;
		const { fetch } = mockTransport({
			mutate: (body) => {
				mutateCalls += 1;
				return {
					results: (body.mutations as { clientId: string }[]).map((m) => ({
						clientId: m.clientId,
						status: 'rejected' as const,
						reason: 'NOT_FOUND',
						detail: 'Record with ID stranger not found.'
					}))
				};
			}
		});
		const client = await makeClient(fetch);
		try {
			const results = await client.mutate([
				{
					clientId: 'delete-1',
					collection: 'orders',
					action: 'delete',
					row: { norbital_id: 'stranger' }
				}
			]);
			expect(mutateCalls).toBe(1);
			expect(results[0]?.status).toBe('rejected');
			expect((results[0] as { reason: string }).reason).toBe('NOT_FOUND');
		} finally {
			await client.close();
		}
	});

	/** The outbox is what the pending indicator is derived from, so it has to name its records. */
	it('reports the records whose writes have not settled yet', async () => {
		const { fetch } = mockTransport({});
		const client = await makeClient(fetch);
		try {
			client.setOnline(false);
			await client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'create',
					row: { norbital_id: 'unsettled', status: 'draft' }
				}
			]);
			expect([...(await client.pendingRecordIds('orders'))]).toEqual(['unsettled']);
			expect((await client.pendingRecordIds('customers')).size).toBe(0);

			await client.queryLocal(`DELETE FROM _pod_pending`);
			expect((await client.pendingRecordIds('orders')).size).toBe(0);
		} finally {
			await client.close();
		}
	});

	it('applies streamed diffs and evicts on delete/leave', async () => {
		const { fetch } = mockTransport({});
		const client = await makeClient(fetch);
		try {
			await client.applyDiff({
				seq: '1',
				xid: '1',
				collection: 'orders',
				action: 'insert',
				id: 'a',
				version: 1,
				row: { norbital_id: 'a', norbital_row_version: 1, status: 'open' }
			});
			expect(await client.count('orders')).toBe(1);
			await client.applyDiff({
				seq: '2',
				xid: '2',
				collection: 'orders',
				action: 'update',
				id: 'a',
				version: 2,
				row: { norbital_id: 'a', norbital_row_version: 2, status: 'closed' }
			});
			expect(
				(
					await client.queryLocal<{ status: string }>(
						`SELECT status FROM orders WHERE norbital_id='a'`
					)
				)[0]?.status
			).toBe('closed');
			await client.applyDiff({
				seq: '3',
				xid: '3',
				collection: 'orders',
				action: 'leave',
				id: 'a',
				version: 2
			});
			expect(await client.count('orders')).toBe(0);
		} finally {
			await client.close();
		}
	});

	it('resolves command barriers only after the replica crosses their feed sequence', async () => {
		const client = await makeClient(mockTransport({}).fetch);
		try {
			const waiting = client.waitForSequence('12', { timeoutMs: 1_000 });
			await client.applyDiff({
				seq: '12',
				xid: '44',
				collection: 'orders',
				action: 'delete',
				id: 'gone',
				version: 1
			});
			expect(await waiting).toBe(true);
			expect(await client.waitForSequence('not-a-sequence')).toBe(false);
		} finally {
			await client.close();
		}
	});

	it('starts the live feed when a cold snapshot already satisfies the command barrier', async () => {
		const { fetch, calls } = mockTransport({
			shape: () =>
				shapePage([], {
					watermark: '12',
					cursor: { xid: '44', seq: '12' }
				})
		});
		const client = await makeClient(fetch);
		try {
			await client.shapeSubscribe({ collection: 'orders' });
			expect(await client.waitForSequence('12')).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(calls.some((path) => path.startsWith('sync/stream'))).toBe(true);
		} finally {
			await client.close();
		}
	});

	it('collapses repeated row versions within one streamed batch', async () => {
		const client = await makeClient(mockTransport({}).fetch);
		try {
			await client.applyDiffs([
				{
					seq: '1',
					xid: '10',
					collection: 'orders',
					action: 'insert',
					id: 'same',
					version: 1,
					row: { norbital_id: 'same', norbital_row_version: 1, status: 'first' }
				},
				{
					seq: '2',
					xid: '10',
					collection: 'orders',
					action: 'update',
					id: 'same',
					version: 2,
					row: { norbital_id: 'same', norbital_row_version: 2, status: 'last' }
				}
			]);

			expect(await client.localRow('orders', 'same')).toMatchObject({
				norbital_row_version: 2,
				status: 'last'
			});
			const cursor = await client.queryLocal<{ value: string }>(
				`SELECT value FROM _pod_meta WHERE key = 'cursor'`
			);
			expect(JSON.parse(cursor[0]!.value)).toEqual({ xid: '10', seq: '2' });
		} finally {
			await client.close();
		}
	});

	it('does not let an older server row overwrite a confirmed newer version', async () => {
		const client = await makeClient(mockTransport({}).fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'same',
				norbital_row_version: 2,
				status: 'calculated'
			});

			// Models a query that began before the mutation and completed after its version-2 result.
			await client.upsertRow('orders', {
				norbital_id: 'same',
				norbital_row_version: 1,
				status: 'draft'
			});
			expect(await client.localRow('orders', 'same')).toMatchObject({
				norbital_row_version: 2,
				status: 'calculated'
			});

			// Optimistic changes use the current version until the server assigns the next one.
			await client.upsertRow('orders', {
				norbital_id: 'same',
				norbital_row_version: 2,
				status: 'paid'
			});
			expect(await client.localRow('orders', 'same')).toMatchObject({
				norbital_row_version: 2,
				status: 'paid'
			});
		} finally {
			await client.close();
		}
	});

	/**
	 * A burst is applied in one pass, not one replica round trip per row. That is what decides
	 * whether anything committed *after* a bulk write can be seen: applying ~1,300 rows one at a
	 * time (the row, then the durable cursor) left the client still chewing through the burst long
	 * after the change that mattered had been delivered. Merging is only ever allowed between
	 * adjacent like diffs, so the feed's order still decides the outcome.
	 */
	it('applies a burst in one pass while keeping feed order', async () => {
		const { fetch } = mockTransport({});
		const client = await makeClient(fetch);
		const writes: string[] = [];
		const original = client.db.query.bind(client.db);
		client.db.query = ((sql: string, params?: unknown[]) => {
			if (/^\s*(insert|delete)/i.test(sql) && !sql.includes('_pod_')) writes.push(sql);
			return original(sql, params);
		}) as typeof client.db.query;

		try {
			const burst: SyncDiff[] = [];
			for (let index = 0; index < 50; index++) {
				burst.push({
					seq: String(index + 1),
					xid: '1',
					collection: 'orders',
					action: 'insert',
					id: `row-${index}`,
					version: 1,
					row: { norbital_id: `row-${index}`, norbital_row_version: 1, status: 'open' }
				});
			}
			// The last row is created and then removed inside the same burst: order decides.
			burst.push({
				seq: '51',
				xid: '1',
				collection: 'orders',
				action: 'delete',
				id: 'row-49',
				version: 1
			});

			const touched = await client.applyDiffs(burst);

			expect(await client.count('orders')).toBe(49);
			expect(await client.localVersion('orders', 'row-49')).toBeNull();
			expect([...touched]).toEqual(['orders']);
			// One insert statement for the run of inserts, one delete for the run of deletes.
			expect(writes).toHaveLength(2);
		} finally {
			client.db.query = original;
			await client.close();
		}
	});

	it('notifyCollection dispatches to listeners (drives reactive invalidation)', async () => {
		const { fetch } = mockTransport({});
		const client = await makeClient(fetch);
		const changed: string[] = [];
		client.onChange((collection) => changed.push(collection));
		try {
			client.notifyCollection('orders');
			expect(changed).toContain('orders');
		} finally {
			await client.close();
		}
	});

	it('sets the stream cursor from shape response so live sync resumes at the watermark', async () => {
		let streamUrl = '';
		const { fetch, calls } = mockTransport({
			shape: () =>
				shapePage([{ norbital_id: 'a', norbital_row_version: 1, status: 'open' }], {
					watermark: '42',
					cursor: { xid: '100', seq: '42' }
				}),
			stream: () => []
		});
		// Intercept the stream call to capture the cursor param.
		const originalFetch = fetch;
		const interceptedFetch: SyncFetch = async (path, init) => {
			if (path.startsWith('sync/stream')) streamUrl = path;
			return originalFetch(path, init);
		};
		const client = await makeClient(interceptedFetch);
		try {
			await client.shapeSubscribe({ collection: 'orders' });
			client.setSubscribedCollections(['orders']);
			client.startStream();
			await new Promise((r) => setTimeout(r, 100));
			await client.stopStream();

			expect(streamUrl).toContain('cursor=');
			const encodedCursor = new URL(`http://pod.local/${streamUrl}`).searchParams.get('cursor');
			expect(encodedCursor).not.toBeNull();
			const cursorJson = Buffer.from(encodedCursor!, 'base64url').toString('utf8');
			const cursor = JSON.parse(cursorJson);
			expect(cursor.xid).toBe('100');
			expect(cursor.seq).toBe('42');
		} finally {
			await client.close();
		}
	});

	it('advances both halves of the cursor from streamed diffs', async () => {
		const client = await makeClient(mockTransport({}).fetch);
		try {
			await client.applyDiff({
				seq: '9',
				xid: '500',
				collection: 'orders',
				action: 'insert',
				id: 'a',
				version: 1,
				row: { norbital_id: 'a', norbital_row_version: 1, status: 'open' }
			});
			const [meta] = await client.queryLocal<{ value: string }>(
				`SELECT value FROM _pod_meta WHERE key = 'cursor'`
			);
			// Carrying a stale xid forward would replay the whole feed on every reconnect.
			expect(JSON.parse(meta!.value)).toEqual({ xid: '500', seq: '9' });
		} finally {
			await client.close();
		}
	});

	it('shows an update locally before the server confirms it', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch: SyncFetch = async (path, init) => {
			if (path.startsWith('sync/mutate')) {
				await gate;
				const body = JSON.parse(init.body!) as { mutations: { clientId: string }[] };
				return jsonResponse({
					results: body.mutations.map((m) => ({
						clientId: m.clientId,
						status: 'confirmed' as const,
						serverId: 'x',
						row: { norbital_id: 'x', norbital_row_version: 2, status: 'closed' }
					}))
				});
			}
			return new Response('not found', { status: 404 });
		};
		const client = await makeClient(fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'x',
				norbital_row_version: 1,
				status: 'open'
			});
			const pending = client.mutate([
				{
					clientId: 'c1',
					collection: 'orders',
					action: 'update',
					row: { norbital_id: 'x', status: 'closed' },
					version: 1
				}
			]);

			// The server has not answered yet — the replica must already show the new value.
			await new Promise((r) => setTimeout(r, 0));
			const optimistic = await client.localRow('orders', 'x');
			expect(optimistic?.status).toBe('closed');

			release!();
			await pending;
			const confirmed = await client.localRow('orders', 'x');
			expect(confirmed?.norbital_row_version).toBe(2);
		} finally {
			await client.close();
		}
	});

	it('shows a create locally with its final UUIDv7 before the server confirms it', async () => {
		let release: (() => void) | undefined;
		let sentId: string | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch: SyncFetch = async (path, init) => {
			if (!path.startsWith('sync/mutate')) return new Response('not found', { status: 404 });
			const body = JSON.parse(init.body!) as {
				mutations: Array<{ clientId: string; row: Record<string, unknown> }>;
			};
			sentId = String(body.mutations[0]!.row.norbital_id);
			await gate;
			return jsonResponse({
				results: [
					{
						clientId: body.mutations[0]!.clientId,
						status: 'confirmed',
						serverId: sentId,
						row: {
							...body.mutations[0]!.row,
							norbital_row_version: 1,
							status: 'server-normalized'
						}
					}
				]
			});
		};
		const client = await makeClient(fetch);
		try {
			const pending = client.mutate([
				{ clientId: 'create-1', collection: 'orders', action: 'create', row: { status: 'draft' } }
			]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(sentId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			);
			expect(await client.localRow('orders', sentId!)).toMatchObject({ status: 'draft' });

			release!();
			await pending;
			expect(await client.localRow('orders', sentId!)).toMatchObject({
				norbital_id: sentId,
				norbital_row_version: 1,
				status: 'server-normalized'
			});
		} finally {
			await client.close();
		}
	});

	it('removes an optimistic create when the server rejects it', async () => {
		let sentId: string | undefined;
		const { fetch } = mockTransport({
			mutate: (body) => {
				const mutation = body.mutations[0] as {
					clientId: string;
					row: Record<string, unknown>;
				};
				sentId = String(mutation.row.norbital_id);
				return {
					results: [
						{ clientId: mutation.clientId, status: 'rejected', reason: 'PERMISSION_DENIED' }
					]
				};
			}
		});
		const client = await makeClient(fetch);
		try {
			const result = await client.mutate([
				{
					clientId: 'create-rejected',
					collection: 'orders',
					action: 'create',
					row: { status: 'x' }
				}
			]);
			expect(result[0]?.status).toBe('rejected');
			expect(await client.localRow('orders', sentId!)).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('sends only subscribed collections on the stream connection', async () => {
		const { fetch, calls } = mockTransport({
			shape: () => shapePage([]),
			stream: () => []
		});
		const client = await makeClient(fetch);
		try {
			await client.shapeSubscribe({ collection: 'orders' });
			client.startStream();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const streamCall = calls.find((call) => call.startsWith('sync/stream?'));
			expect(streamCall).toBeDefined();
			expect(new URL(`http://pod.local/${streamCall}`).searchParams.getAll('collection')).toEqual([
				'orders'
			]);
		} finally {
			await client.close();
		}
	});

	it('persists cursor-only progress for filtered-out collections', async () => {
		let collectionChanges = 0;
		const fetch: SyncFetch = async (path) => {
			if (!path.startsWith('sync/stream')) return new Response('not found', { status: 404 });
			return new Response('event: cursor\ndata: {"xid":"30","seq":"52"}\n\n', {
				headers: { 'content-type': 'text/event-stream' }
			});
		};
		const client = await makeClient(fetch);
		const stop = client.onChange(() => (collectionChanges += 1));
		try {
			client.startStream();
			for (let attempt = 0; attempt < 20; attempt++) {
				const cursor = await client.queryLocal<{ value: string }>(
					`SELECT value FROM _pod_meta WHERE key = 'cursor'`
				);
				if (cursor[0] && JSON.parse(cursor[0].value).seq === '52') break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const cursor = await client.queryLocal<{ value: string }>(
				`SELECT value FROM _pod_meta WHERE key = 'cursor'`
			);
			expect(JSON.parse(cursor[0]!.value)).toEqual({ xid: '30', seq: '52' });
			// Cursor-only frames are bookkeeping and must not invalidate collection queries.
			expect(collectionChanges).toBe(0);
		} finally {
			stop();
			await client.close();
		}
	});

	it('discards scoped rows and resumes after a policy scope-reset event', async () => {
		let reset!: () => void;
		const resetObserved = new Promise<void>((resolve) => {
			reset = resolve;
		});
		const fetch: SyncFetch = async (path) => {
			if (!path.startsWith('sync/stream')) return new Response('not found', { status: 404 });
			return new Response('event: scope-reset\ndata: {"xid":"22","seq":"41"}\n\n', {
				headers: { 'content-type': 'text/event-stream' }
			});
		};
		const client = await makeClient(fetch);
		client.onReset(reset);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'visible-before-policy-edit',
				norbital_row_version: 1,
				status: 'open'
			});
			client.startStream();
			await resetObserved;
			expect(await client.count('orders')).toBe(0);
			const cursor = await client.queryLocal<{ value: string }>(
				`SELECT value FROM _pod_meta WHERE key = 'cursor'`
			);
			expect(JSON.parse(cursor[0]!.value)).toEqual({ xid: '22', seq: '41' });
		} finally {
			await client.close();
		}
	});

	it('rolls a rejected delete back into the replica', async () => {
		const { fetch } = mockTransport({
			mutate: (body) => ({
				results: (body.mutations as { clientId: string }[]).map((m) => ({
					clientId: m.clientId,
					status: 'rejected' as const,
					reason: 'PERMISSION_DENIED'
				}))
			})
		});
		const client = await makeClient(fetch);
		try {
			await client.upsertRow('orders', {
				norbital_id: 'x',
				norbital_row_version: 1,
				status: 'open'
			});
			await client.mutate([
				{ clientId: 'c1', collection: 'orders', action: 'delete', row: { norbital_id: 'x' } }
			]);
			const restored = await client.localRow('orders', 'x');
			expect(restored?.status).toBe('open');
		} finally {
			await client.close();
		}
	});

	it('discards stale rows and pending mutations when the physical database epoch changes', async () => {
		const db = await createClientDb();
		const fetch = mockTransport({}).fetch;
		const original = new PodSyncClient({
			db,
			schemaSql: SCHEMA,
			replicaEpoch: 'database-a',
			fetch
		});
		await original.bootstrap();
		await original.upsertRow('orders', {
			norbital_id: 'old',
			norbital_row_version: 1,
			status: 'open'
		});
		await original.recordSyncState('orders', true, 1);
		await db.query(
			`INSERT INTO _pod_pending (client_id, collection, action, row, base_version, created_at)
			 VALUES ('pending-old', 'orders', 'update', '{"norbital_id":"old"}', 1, 1)`
		);

		// A bulk reseed may already have a higher outbox watermark than the old database. The epoch,
		// rather than sequence ordering, is the definitive reset signal.
		const reset = new PodSyncClient({
			db,
			schemaSql: SCHEMA,
			replicaEpoch: 'database-b',
			fetch
		});
		await reset.bootstrap();
		try {
			expect(await reset.count('orders')).toBe(0);
			expect((await reset.loadSyncState()).size).toBe(0);
			const pending = await db.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM _pod_pending`
			);
			expect(pending.rows[0]?.count).toBe(0);
		} finally {
			await reset.close();
		}
	});

	it('adds a new column without discarding synced rows', async () => {
		const db = await createClientDb();
		const base = [
			`CREATE TABLE IF NOT EXISTS "orders" ("norbital_id" text PRIMARY KEY);`,
			`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "status" text;`
		].join('\n');
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: base,
			fetch: mockTransport({}).fetch
		});
		await client.bootstrap();
		await client.upsertRow('orders', { norbital_id: 'a', status: 'open' });

		// A workspace edit adds a field. The replica must keep its rows and just gain the column —
		// a wipe here would re-download everything on every schema change.
		const widened = `${base}\nALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "total" integer;`;
		const reloaded = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: widened,
			fetch: mockTransport({}).fetch
		});
		await reloaded.bootstrap();
		try {
			const row = await reloaded.localRow('orders', 'a');
			expect(row?.status).toBe('open');
			expect(row && 'total' in row).toBe(true);
		} finally {
			await reloaded.close();
		}
	});

	it('drops and re-syncs only the table that lost a column', async () => {
		const db = await createClientDb();
		const base = [
			`CREATE TABLE IF NOT EXISTS "orders" ("norbital_id" text PRIMARY KEY);`,
			`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "status" text;`,
			`CREATE TABLE IF NOT EXISTS "customers" ("norbital_id" text PRIMARY KEY);`,
			`ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "name" text;`
		].join('\n');
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: base,
			fetch: mockTransport({}).fetch
		});
		await client.bootstrap();
		await client.upsertRow('orders', { norbital_id: 'a', status: 'open' });
		await client.upsertRow('customers', { norbital_id: 'c', name: 'Acme' });
		await client.recordSyncState('orders', true, 1);
		await client.recordSyncState('customers', true, 1);

		// `status` is gone from orders — a rename or retype. Only orders may be rebuilt.
		const narrowed = [
			`CREATE TABLE IF NOT EXISTS "orders" ("norbital_id" text PRIMARY KEY);`,
			`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "state" text;`,
			`CREATE TABLE IF NOT EXISTS "customers" ("norbital_id" text PRIMARY KEY);`,
			`ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "name" text;`
		].join('\n');
		const reloaded = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: narrowed,
			fetch: mockTransport({}).fetch
		});
		await reloaded.bootstrap();
		try {
			expect(await reloaded.count('orders')).toBe(0);
			expect(await reloaded.count('customers')).toBe(1);
			const state = await reloaded.loadSyncState();
			expect(state.has('orders')).toBe(false);
			expect(state.get('customers')?.resident).toBe(true);
		} finally {
			await reloaded.close();
		}
	});

	/**
	 * A bind message counts its parameters in a signed int16, so a single statement can carry at
	 * most 32767. `upsertRows` chunks for exactly this reason, but it sized the chunk against 65535
	 * — twice the real ceiling — so a wide-enough collection produced one oversized statement,
	 * PGlite threw `Invalid array length`, and `runCatchUp` swallowed it. The collection then never
	 * became resident and the replica appeared to download forever.
	 *
	 * 40 columns × 1000 rows = 40,000 parameters, which is an ordinary page of an ordinary wide
	 * collection and used to fail.
	 */
	it('chunks a wide bulk upsert under the bind-parameter ceiling', async () => {
		const columns = Array.from({ length: 39 }, (_value, index) => `field_${index}`);
		const schema = [
			`CREATE TABLE IF NOT EXISTS "wide" ("norbital_id" text PRIMARY KEY);`,
			...columns.map((column) => `ALTER TABLE "wide" ADD COLUMN IF NOT EXISTS "${column}" text;`)
		].join('\n');

		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: schema,
			fetch: mockTransport({}).fetch
		});
		await client.bootstrap();
		try {
			const rows = Array.from({ length: 1000 }, (_value, index) => ({
				norbital_id: `row-${index}`,
				...Object.fromEntries(columns.map((column) => [column, `${column}-${index}`]))
			}));
			await client.upsertRows('wide', rows);
			expect(await client.count('wide')).toBe(1000);
		} finally {
			await client.close();
		}
	});

	it('does not record a Firefox input-stream TypeError as lastError', async () => {
		const fetch: SyncFetch = async (path) => {
			if (!path.startsWith('sync/stream')) {
				return new Response('not found', { status: 404 });
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					queueMicrotask(() => controller.error(new TypeError('Error in input stream')));
				}
			});
			return new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		};
		const client = await makeClient(fetch);
		try {
			client.startStream();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(client.lastError).toBeUndefined();
		} finally {
			await client.close();
		}
	});
});
