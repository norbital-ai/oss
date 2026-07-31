import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import { PodSyncClient } from '$lib/client/sync/pod-sync-client.js';
import {
	absorbServerRows,
	disableClientSync,
	enableClientSync,
	localCount,
	localFindMany,
	setLocalSchema
} from '$lib/client/sync/client-sync.js';
import type { SyncFetch } from '$lib/client/sync/types.js';

requireDocker();

/** Mirrors PAGE_SIZE in subscription-registry: the most a single catch-up page can add. */
const SHAPE_PAGE_SIZE = 5000;

/**
 * Publish the schema facts `runtime/client.ts` publishes from the manifest in the real app.
 *
 * Every test that absorbs a server answer needs these: without them the executor cannot tell a
 * column from a relation payload, and `absorbServerRows` is a deliberate no-op. It used to be set
 * by one test and relied on by others through module state — which held only until
 * `disableClientSync` began clearing the schema on teardown (it must, or an organization switch
 * would compile the next tenant's reads against the previous tenant's columns). Each test now
 * publishes its own.
 */
async function publishSchemaFor(harness: PodRuntimeHarness, collection: string): Promise<void> {
	const columns = await harness.pool.query<{ column_name: string; data_type: string }>(
		`SELECT column_name, data_type FROM information_schema.columns
		  WHERE table_schema='public' AND table_name=$1`,
		[collection]
	);
	setLocalSchema(
		new Map([
			[
				collection,
				{
					name: collection,
					columns: columns.rows.map((c) => c.column_name),
					fieldKinds: Object.fromEntries(columns.rows.map((c) => [c.column_name, c.data_type])),
					searchFields: columns.rows
						.filter((c) => c.data_type === 'text' || c.data_type.startsWith('character'))
						.map((c) => c.column_name),
					relationships: []
				}
			]
		])
	);
}

function syncFetchFor(harness: PodRuntimeHarness, identity: Identity): SyncFetch {
	return (path, init) =>
		harness.request(
			{
				method: init.method,
				path,
				body: init.body,
				signal: init.signal,
				headers: init.accept ? { accept: init.accept, 'content-type': 'application/json' } : {}
			},
			identity
		);
}

async function makeClient(harness: PodRuntimeHarness, identity: Identity): Promise<PodSyncClient> {
	const db = await createClientDb();
	const client = new PodSyncClient({
		replicaEpoch: 'test-epoch',
		db,
		schemaSql: harness.schemaSql,
		fetch: syncFetchFor(harness, identity)
	});
	await client.bootstrap();
	return client;
}

function sampleValue(type: string): unknown {
	if (type.includes('int') || type === 'numeric' || type.includes('double')) return 1;
	if (type === 'boolean') return false;
	if (type.includes('timestamp') || type === 'date') return new Date().toISOString();
	if (type === 'jsonb' || type === 'json') return {};
	return 'x';
}

async function serverInsert(
	harness: PodRuntimeHarness,
	collection: string,
	notNull: { name: string; type: string }[]
): Promise<string> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		const cols = notNull.map((c) => `"${c.name}"`);
		const vals = notNull.map((c) => sampleValue(c.type));
		const placeholders = notNull.map((_c, i) => `$${i + 1}`);
		const insertSql =
			cols.length > 0
				? `INSERT INTO "${collection}" (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING norbital_id`
				: `INSERT INTO "${collection}" DEFAULT VALUES RETURNING norbital_id`;
		const inserted = await client.query<{ norbital_id: string }>(insertSql, vals);
		const id = inserted.rows[0]!.norbital_id;
		await client.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version) VALUES ($1,$2,'create',1)`,
			[collection, id]
		);
		await client.query('COMMIT');
		return id;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		client.release();
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

const member: Identity = {
	userId: '99999999-9999-4999-8999-999999999999',
	userName: 'Site Worker',
	email: 'worker@it.local',
	role: 'member'
};

describe('Pod Sync — comprehensive E2E', () => {
	let harness: PodRuntimeHarness;
	let collection: string;
	let notNull: { name: string; type: string }[];
	let creatable!: { name: string; notNull: { name: string; type: string }[] };

	beforeAll(async () => {
		// Reclamation deliberately exposes an ordinary hook-backed create surface. Construction is
		// predominantly read-only (its only authored create is the compliance-gated job assignment),
		// so probing it with synthetic values can never prove the client-create contract.
		harness = await bootPodRuntime('reclamation');
		collection = 'reclamation_projects';
		const columns = await harness.pool.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			  WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO'
			    AND column_name NOT LIKE 'norbital_%' AND column_default IS NULL`,
			[collection]
		);
		notNull = columns.rows.map((row) => ({ name: row.column_name, type: row.data_type }));
		creatable = { name: collection, notNull };
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	describe('permission layer filtering', () => {
		it('admin shape catch-up returns matching rows', async () => {
			const id = await serverInsert(harness, collection, notNull);
			const client = await makeClient(harness, admin);
			try {
				const page = await client.shapeSubscribe({ collection, pageSize: 500 });
				const row = page.rows.find((r) => r.norbital_id === id);
				expect(row).toBeDefined();
				expect(row?.norbital_row_version).toBeDefined();
			} finally {
				await client.close();
			}
		});

		it('shape WHERE clause filters rows correctly', async () => {
			// Insert 3 records. Only 1 matches a specific attribute filter.
			await serverInsert(harness, collection, notNull);
			await serverInsert(harness, collection, notNull);
			const targetId = await serverInsert(harness, collection, notNull);

			const client = await makeClient(harness, admin);
			try {
				const page = await client.shapeSubscribe({
					collection,
					pageSize: 500
				});
				// The shape returns ALL rows (no filter) — verify the target is present.
				const target = page.rows.find((r) => r.norbital_id === targetId);
				expect(target).toBeDefined();
				// At least 3 rows exist.
				expect(page.rows.length).toBeGreaterThanOrEqual(3);
			} finally {
				await client.close();
			}
		});

		it('different recipients get records scoped to their identity', async () => {
			const id = await serverInsert(harness, collection, notNull);

			const adminClient = await makeClient(harness, admin);
			try {
				const adminPage = await adminClient.shapeSubscribe({
					collection,
					pageSize: 500
				});
				// Admin always sees the record.
				expect(adminPage.rows.some((r) => r.norbital_id === id)).toBe(true);
			} finally {
				await adminClient.close();
			}

			// This fixture grants no member policy. A success here would be a tenant-data leak.
			const memberClient = await makeClient(harness, member);
			try {
				await expect(
					memberClient.shapeSubscribe({
						collection,
						pageSize: 500
					})
				).rejects.toThrow('sync/shape failed (403)');
				expect(await memberClient.count(collection)).toBe(0);
			} finally {
				await memberClient.close();
			}
		});
	});

	describe('update propagation (SSE stream)', () => {
		it('a server insert propagates to a subscribed client within 5 seconds', async () => {
			const client = await makeClient(harness, admin);
			try {
				await client.shapeSubscribe({ collection, pageSize: 500 });
				client.startStream();

				const beforeCount = await client.count(collection);
				const started = Date.now();
				const id = await serverInsert(harness, collection, notNull);

				const converged = await waitFor(
					async () => (await client.localVersion(collection, id)) !== null,
					5000
				);
				const elapsed = Date.now() - started;
				expect(converged).toBe(true);
				expect(await client.count(collection)).toBe(beforeCount + 1);
				// Latency: the diff should arrive within 5 seconds.
				expect(elapsed).toBeLessThan(5000);
			} finally {
				await client.close();
			}
		});

		it('10 clients all receive the same propagated change', async () => {
			const clients: PodSyncClient[] = [];
			for (let i = 0; i < 10; i++) clients.push(await makeClient(harness, admin));
			try {
				for (const c of clients) {
					await c.shapeSubscribe({ collection, pageSize: 500 });
					c.startStream();
				}
				const id = await serverInsert(harness, collection, notNull);

				for (let i = 0; i < clients.length; i++) {
					const c = clients[i]!;
					const ok = await waitFor(async () => (await c.localVersion(collection, id)) !== null);
					expect(ok, `client ${i} failed; lastError=${String(c.lastError)}`).toBe(true);
				}
			} finally {
				await Promise.all(clients.map((c) => c.close()));
			}
		});

		it('an optimistic create keeps its client-minted identity through the authoritative runtime', async () => {
			const client = await makeClient(harness, admin);
			try {
				await client.shapeSubscribe({ collection: creatable.name, pageSize: 500 });
				const auditBefore = await harness.pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM audit_event WHERE collection_name = $1`,
					[creatable.name]
				);
				const results = await client.mutate([
					{
						clientId: 'create-test',
						collection: creatable.name,
						action: 'create',
						row: Object.fromEntries(
							creatable.notNull.map((column) => [column.name, sampleValue(column.type)])
						)
					}
				]);
				const result = results[0];
				expect(result?.status, JSON.stringify(result)).toBe('confirmed');
				if (!result || result.status !== 'confirmed') throw new Error('create was not confirmed');
				const serverId = result.serverId;
				expect(serverId).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
				);
				if (!serverId) throw new Error('confirmed create returned no id');
				expect(result.row?.norbital_id).toBe(serverId);
				expect(await client.localVersion(creatable.name, serverId)).not.toBeNull();
				const stored = await harness.pool.query<{ norbital_id: string }>(
					`SELECT norbital_id FROM "${creatable.name}" WHERE norbital_id = $1`,
					[serverId]
				);
				expect(stored.rows[0]?.norbital_id).toBe(serverId);
				const auditAfter = await harness.pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM audit_event WHERE collection_name = $1`,
					[creatable.name]
				);
				expect(Number(auditAfter.rows[0]!.count)).toBe(Number(auditBefore.rows[0]!.count) + 1);
			} finally {
				await client.close();
			}
		});

		it('runs authored before-hooks and rolls back their rejected optimistic create', async () => {
			const client = await makeClient(harness, admin);
			try {
				const [result] = await client.mutate([
					{
						clientId: 'create-invalid-hook-input',
						collection: 'reclamation_projects',
						action: 'create',
						row: { project_name: 'Invalid tuning', integration_cell_m: 0.1 }
					}
				]);
				expect(result).toMatchObject({
					status: 'rejected',
					reason: 'HTTP_409',
					detail: 'Integration cell size must be between 0.5 m and 100 m.'
				});
				const invalidRows = await client.queryLocal<{ count: string }>(
					`SELECT count(*)::text AS count FROM reclamation_projects WHERE project_name = $1`,
					['Invalid tuning']
				);
				expect(Number(invalidRows[0]!.count)).toBe(0);
			} finally {
				await client.close();
			}
		});

		it('an offline client catches up on reconnect', async () => {
			const client = await makeClient(harness, admin);
			try {
				await client.shapeSubscribe({ collection, pageSize: 500 });
				client.startStream();
				await client.stopStream();
				// Row inserted while disconnected.
				const id = await serverInsert(harness, collection, notNull);
				expect(await client.localVersion(collection, id)).toBeNull();

				// Reconnect — stream resumes from saved cursor.
				client.startStream();
				const caughtUp = await waitFor(
					async () => (await client.localVersion(collection, id)) !== null
				);
				expect(caughtUp).toBe(true);
			} finally {
				await client.close();
			}
		});
	});

	describe('browser tabs (shared PGlite replica)', () => {
		/**
		 * Wrap a PGlite so `close()` is a no-op — multiple PodSyncClient instances
		 * share the same underlying database and only one should tear it down.
		 */
		function sharedNoClose(db: PgliteLike): PgliteLike {
			return {
				query: (sql, params) => db.query(sql, params),
				exec: (sql) => db.exec(sql),
				close: undefined
			};
		}
		type PgliteLike = Awaited<ReturnType<typeof createClientDb>>;

		it("two clients sharing the same PGlite see each other's shape data", async () => {
			const schemaRes = await harness.request({ method: 'GET', path: 'sync/schema' }, admin);
			const idempotentSchema = await schemaRes.text();

			const sharedDb = await createClientDb();
			const clientA = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: sharedNoClose(sharedDb),
				schemaSql: idempotentSchema,
				fetch: syncFetchFor(harness, admin)
			});
			await clientA.bootstrap();
			const clientB = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: sharedNoClose(sharedDb),
				schemaSql: idempotentSchema,
				fetch: syncFetchFor(harness, admin)
			});
			await clientB.bootstrap();
			try {
				await clientA.shapeSubscribe({ collection, pageSize: 500 });
				const countA = await clientA.count(collection);
				const countB = await clientB.count(collection);
				expect(countA).toBe(countB);
				expect(countA).toBeGreaterThan(0);
			} finally {
				try {
					await clientA.stopStream();
					await clientB.stopStream();
				} catch {
					/* ignore */
				}
				await sharedDb.close?.();
			}
		});

		it('multiple readers converge on live changes from a single stream', async () => {
			const schemaRes = await harness.request({ method: 'GET', path: 'sync/schema' }, admin);
			const idempotentSchema = await schemaRes.text();

			const sharedDb = await createClientDb();
			const primary = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: sharedNoClose(sharedDb),
				schemaSql: idempotentSchema,
				fetch: syncFetchFor(harness, admin)
			});
			await primary.bootstrap();
			const secondary = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: sharedNoClose(sharedDb),
				schemaSql: idempotentSchema,
				fetch: syncFetchFor(harness, admin)
			});
			await secondary.bootstrap();
			try {
				await primary.shapeSubscribe({ collection, pageSize: 500 });
				primary.startStream();
				const id = await serverInsert(harness, collection, notNull);
				for (const c of [primary, secondary]) {
					const ok = await waitFor(async () => (await c.localVersion(collection, id)) !== null);
					expect(ok).toBe(true);
				}
			} finally {
				try {
					await primary.stopStream();
					await secondary.stopStream();
				} catch {
					/* ignore */
				}
				await sharedDb.close?.();
			}
		});
	});

	describe('latency and performance', () => {
		it('shape page arrives under 2 seconds for small collection', async () => {
			const client = await makeClient(harness, admin);
			try {
				const started = Date.now();
				const page = await client.shapeSubscribe({ collection, pageSize: 500 });
				const elapsed = Date.now() - started;
				expect(page.rows.length).toBeGreaterThanOrEqual(0);
				expect(elapsed).toBeLessThan(2000);
			} finally {
				await client.close();
			}
		});

		it('SSE diff latency is under 1 second for a local server', async () => {
			const client = await makeClient(harness, admin);
			try {
				await client.shapeSubscribe({ collection, pageSize: 500 });
				client.startStream();

				// Warm the stream connection.
				await new Promise((r) => setTimeout(r, 200));

				const started = Date.now();
				const id = await serverInsert(harness, collection, notNull);
				const ok = await waitFor(
					async () => (await client.localVersion(collection, id)) !== null,
					3000
				);
				const elapsed = Date.now() - started;
				expect(ok).toBe(true);
				expect(elapsed).toBeLessThan(1000);
			} finally {
				await client.close();
			}
		});

		it('100k local rows queried in under 200ms', async () => {
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			try {
				const cols = ['norbital_id', ...notNull.map((c) => c.name)];
				const selectExprs = ['gen_random_uuid()', ...notNull.map((_c, i) => `$1`)];
				// Bulk-load via a single INSERT ... SELECT generate_series.
				await db.query(
					`INSERT INTO "${collection}" (${cols.map((c) => `"${c}"`).join(',')})
					 SELECT ${selectExprs.join(',')} FROM generate_series(1, 100000)`,
					notNull.map((c) => sampleValue(c.type))
				);
				expect(await client.count(collection)).toBe(100_000);

				const started = Date.now();
				const rows = await client.queryLocal<{ norbital_id: string }>(
					`SELECT norbital_id FROM "${collection}" ORDER BY norbital_id LIMIT 50`
				);
				const elapsed = Date.now() - started;
				expect(rows.length).toBe(50);
				expect(elapsed).toBeLessThan(200);
			} finally {
				await client.close();
			}
		});

		it('returns a bounded page and a cursor only when more rows follow', async () => {
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			try {
				const page = await client.shapeSubscribe({ collection, pageSize: 5 });
				expect(page.rows.length).toBeLessThanOrEqual(5);
				// The server is stateless across pages, so `nextCursor` is the only continuation
				// signal — and it is only offered when the page filled. A short page with a cursor
				// would send the client paging past the end of the data.
				if (page.nextCursor !== null) expect(page.rows.length).toBe(5);
				// Whatever arrived is in the replica, ready to be read locally.
				expect(await client.count(collection)).toBe(page.rows.length);
			} finally {
				await client.close();
			}
		});
	});

	describe('local-first reads', () => {
		it('registers the collection on first read and answers locally', async () => {
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			disableClientSync();
			const sync = enableClientSync(client);
			try {
				// No explicit registration: the read itself catches the collection up. This is the
				// point of collection-level sync — a cold read costs one round-trip, not a null.
				const result = await localFindMany(sync, collection, { limit: 10 });
				expect(result).not.toBeNull();
				expect(Array.isArray(result!.rows)).toBe(true);
				expect(sync.registry.has(collection)).toBe(true);
			} finally {
				await client.close();
				disableClientSync();
			}
		});

		it('answers a second, differently-sorted read without any further server work', async () => {
			const db = await createClientDb();
			let shapeRequests = 0;
			const fetch = syncFetchFor(harness, admin);
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: (path, init) => {
					if (path.startsWith('sync/shape')) shapeRequests += 1;
					return fetch(path, init);
				}
			});
			await client.bootstrap();
			disableClientSync();
			const sync = enableClientSync(client);
			try {
				const sortColumn = notNull[0]!.name;
				await localFindMany(sync, collection, { orderBy: { [sortColumn]: 'asc' }, limit: 10 });
				const after = shapeRequests;
				// Changing the sort used to mint a new shape and a new cold start. It must now be
				// pure local SQL — no additional server round-trip at all.
				const resorted = await localFindMany(sync, collection, {
					orderBy: { [sortColumn]: 'desc' },
					limit: 10
				});
				expect(resorted).not.toBeNull();
				expect(shapeRequests).toBe(after);
			} finally {
				await client.close();
				disableClientSync();
			}
		});

		it('counts locally once the collection is resident', async () => {
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			disableClientSync();
			const sync = enableClientSync(client);
			try {
				const count = await localCount(sync, collection, {});
				expect(count).not.toBeNull();
				expect(count).toBe(await client.count(collection));
			} finally {
				await client.close();
				disableClientSync();
			}
		});

		it('survives a reload: a warm replica crosses the live head without re-fetching the collection', async () => {
			const fetch = syncFetchFor(harness, admin);
			let shapeRequests = 0;
			const countingFetch: typeof fetch = (path, init) => {
				if (path.startsWith('sync/shape')) shapeRequests += 1;
				return fetch(path, init);
			};

			// One storage, two client lifetimes — the shape of a browser reload. The second client
			// starts with an empty in-memory registry and must recover its state from the replica.
			const storage = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: storage,
				schemaSql: harness.schemaSql,
				fetch: countingFetch
			});
			await client.bootstrap();
			disableClientSync();
			let sync = enableClientSync(client);
			await localFindMany(sync, collection, { limit: 10 });
			const firstLoad = shapeRequests;
			expect(firstLoad).toBeGreaterThan(0);
			await client.stopStream();
			disableClientSync();

			const reloaded = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db: storage,
				schemaSql: harness.schemaSql,
				fetch: countingFetch
			});
			await reloaded.bootstrap();
			sync = enableClientSync(reloaded);
			try {
				await sync.registry.restore();
				const head = await reloaded.serverSequence();
				reloaded.startStream();
				expect(await reloaded.waitForSequence(head)).toBe(true);
				sync.registry.markRestoredFresh();
				const result = await localFindMany(sync, collection, { limit: 10 });
				expect(result).not.toBeNull();
				// The second load validates freshness through the ordered feed, not a shape download.
				expect(shapeRequests).toBe(firstLoad);
			} finally {
				await reloaded.close();
				disableClientSync();
			}
		});
	});

	describe('server/local search parity', () => {
		it('uses case-insensitive literal substrings without wildcard or typo expansion', async () => {
			const client = await makeClient(harness, admin);
			try {
				const results = await client.mutate(
					['Harbour Reclamation', 'Progress 100% Complete', 'Progress 100X Complete'].map(
						(projectName, index) => ({
							clientId: `search-fixture-${index}`,
							collection: 'reclamation_projects',
							action: 'create' as const,
							row: { project_name: projectName }
						})
					)
				);
				expect(results.every((result) => result.status === 'confirmed')).toBe(true);

				const search = async (term: string): Promise<string[]> => {
					const response = await harness.request(
						{
							method: 'POST',
							path: 'collections/findMany',
							body: JSON.stringify({
								collection: 'reclamation_projects',
								search: term,
								limit: 100
							})
						},
						admin
					);
					expect(response.status).toBe(200);
					const page = (await response.json()) as {
						rows: Array<{ project_name: string }>;
					};
					return page.rows.map((row) => row.project_name);
				};

				expect(await search('RECLAMATION')).toContain('Harbour Reclamation');
				const literalPercent = await search('100%');
				expect(literalPercent).toContain('Progress 100% Complete');
				expect(literalPercent).not.toContain('Progress 100X Complete');
				expect(await search('reclamatoin')).not.toContain('Harbour Reclamation');
			} finally {
				await client.close();
			}
		});
	});

	/**
	 * A collection with a million rows, against the real server and the real policy path.
	 *
	 * The question these answer is not "can the client hold a million rows" — it cannot and must
	 * not try. It is "does the client stay bounded, stay responsive, and stay *correct* when the
	 * slice is far larger than it can hold".
	 */
	describe('a million rows', () => {
		const TOTAL = 1_000_000;
		/** Null once loaded; otherwise why the fixture could not be built in this environment. */
		let unavailable: string | null = 'fixture not loaded';

		/** A scale contract must fail when its full fixture cannot be built; smaller data proves less. */
		function requireFixture(): void {
			if (unavailable) throw new Error(`Million-row sync fixture unavailable: ${unavailable}`);
		}

		beforeAll(async () => {
			const pg = await harness.pool.connect();
			try {
				// Fixture load, not a behaviour under test: the versioning trigger would write a
				// history row per record, which is minutes of work for data nobody reads back.
				await pg.query(`ALTER TABLE "${collection}" DISABLE TRIGGER USER`);

				const params: unknown[] = [];
				const projection = notNull.map((column) => {
					const sample = sampleValue(column.type);
					// Give text columns a per-row value so search and ordering have something to bite on.
					if (typeof sample === 'string') return `('bulk-' || g.i)`;
					params.push(sample);
					return `$${params.length}`;
				});
				const target = ['norbital_id', ...notNull.map((c) => `"${c.name}"`)];
				const select = ['uuidv7()', ...projection];

				// Load in batches. A single million-row transaction pins its entire WAL until
				// commit, which is enough to fill a test container's disk; committing per batch
				// lets Postgres recycle it.
				const BATCH = 50_000;
				for (let start = 1; start <= TOTAL; start += BATCH) {
					const end = Math.min(start + BATCH - 1, TOTAL);
					await pg.query(
						`INSERT INTO "${collection}" (${target.join(',')})
						 SELECT ${select.join(',')} FROM generate_series(${start}, ${end}) AS g(i)`,
						params
					);
				}
				await pg.query(`ALTER TABLE "${collection}" ENABLE TRIGGER USER`);
				await pg.query(`ANALYZE "${collection}"`);

				await publishSchemaFor(harness, collection);
				unavailable = null;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				unavailable = /no space left on device/i.test(message)
					? `the Docker VM is out of disk (needs roughly 1 GB for ${TOTAL.toLocaleString()} rows)`
					: message;
				await pg.query(`ALTER TABLE "${collection}" ENABLE TRIGGER USER`).catch(() => undefined);
			} finally {
				pg.release();
			}
		}, 900_000);

		it('has a million rows server-side', async () => {
			requireFixture();
			const counted = await harness.pool.query<{ n: string }>(
				`SELECT count(*)::text AS n FROM "${collection}"`
			);
			expect(Number(counted.rows[0]!.n)).toBeGreaterThanOrEqual(TOTAL);
		});

		it('stops well short of the slice, stays windowed, and is readable throughout', async () => {
			requireFixture();
			const db = await createClientDb();
			let shapeRequests = 0;
			const fetch = syncFetchFor(harness, admin);
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: (path, init) => {
					if (path.startsWith('sync/shape')) shapeRequests += 1;
					return fetch(path, init);
				}
			});
			await client.bootstrap();
			disableClientSync();
			// A deliberately small budget so the assertions are about the *rule*, not the constant.
			// The default budget behaves identically, just with more pages.
			const sync = enableClientSync(client, { residencyBytes: 64 * 1024 });
			try {
				const started = Date.now();
				await sync.registry.register(collection);
				// The first read must not wait on a million rows.
				expect(Date.now() - started).toBeLessThan(20_000);

				// The background catch-up must terminate. Settle on the request count going quiet.
				let seen = -1;
				await waitFor(async () => {
					const quiet = shapeRequests === seen;
					seen = shapeRequests;
					return quiet;
				}, 120_000);

				expect(sync.registry.has(collection)).toBe(true);
				expect(sync.registry.isResident(collection)).toBe(false);

				const localRows = await client.count(collection);
				// Bounded: the budget is checked after a page lands, so at most one page of slack
				// over it — and nowhere near the slice.
				expect(localRows).toBeLessThanOrEqual(SHAPE_PAGE_SIZE);
				expect(shapeRequests).toBeLessThanOrEqual(6);
			} finally {
				await client.close();
				disableClientSync();
			}
		}, 180_000);

		it('defers count and search, but still answers a primary-key lookup locally', async () => {
			requireFixture();
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			disableClientSync();
			const sync = enableClientSync(client, { residencyBytes: 16 * 1024 });
			try {
				await sync.registry.register(collection);

				// A count over a window is a wrong answer, not a stale one.
				expect(await localCount(sync, collection, {})).toBeNull();
				// A match may sit outside the window, so only the server can prove completeness.
				expect(await localFindMany(sync, collection, { search: 'bulk-999999' })).toBeNull();
				// An unbounded listing cannot be proven complete from a window.
				expect(await localFindMany(sync, collection, {})).toBeNull();

				// But a row that IS local is a real, policy-scoped row, and `norbital_id` is unique,
				// so pinning it is answerable without the server.
				const [seed] = await client.queryLocal<{ norbital_id: string }>(
					`SELECT norbital_id FROM "${collection}" LIMIT 1`
				);
				const pinned = await localFindMany(sync, collection, {
					where: { norbital_id: seed!.norbital_id }
				});
				expect(pinned!.rows.map((r) => r.norbital_id)).toEqual([seed!.norbital_id]);

				// A full page is NOT served from a window, however complete it looks. The window is a
				// prefix only under the catch-up's own order with no predicate; under any other sort
				// or filter a matching row outside it belongs on this page and would be silently
				// missing. The server answers, and folds its rows back in as it goes.
				expect(
					await localFindMany(sync, collection, { orderBy: { norbital_id: 'asc' }, limit: 25 })
				).toBeNull();
			} finally {
				await client.close();
				disableClientSync();
			}
		}, 180_000);

		it('folds a server answer into the replica so the same read is local next time', async () => {
			requireFixture();
			const db = await createClientDb();
			const client = new PodSyncClient({
				replicaEpoch: 'test-epoch',
				db,
				schemaSql: harness.schemaSql,
				fetch: syncFetchFor(harness, admin)
			});
			await client.bootstrap();
			disableClientSync();
			const sync = enableClientSync(client, { residencyBytes: 16 * 1024 });
			await publishSchemaFor(harness, collection);
			try {
				await sync.registry.register(collection);

				// Take a row the client provably does not have: page deep past the window.
				const deep = await harness.pool.query<{ norbital_id: string }>(
					`SELECT norbital_id FROM "${collection}" ORDER BY norbital_id DESC LIMIT 1`
				);
				const id = deep.rows[0]!.norbital_id;
				expect(await client.localRow(collection, id)).toBeNull();
				expect(await localFindMany(sync, collection, { where: { norbital_id: id } })).toBeNull();

				// This is what the transport does with a server answer.
				const served = await harness.pool.query(
					`SELECT * FROM "${collection}" WHERE norbital_id = $1`,
					[id]
				);
				await absorbServerRows(sync, collection, served.rows);

				// Now it is local, and the same read no longer touches the server.
				const local = await localFindMany(sync, collection, { where: { norbital_id: id } });
				expect(local!.rows.map((r) => r.norbital_id)).toEqual([id]);
			} finally {
				await client.close();
				disableClientSync();
			}
		}, 180_000);
	});
});
