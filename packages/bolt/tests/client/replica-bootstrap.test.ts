import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, type Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import { readReplicaState, type PGliteLike } from '../../src/client/replica/pglite-sql.js';
import { startLocalReplica, createBrowserWorkspaceRuntime } from '../../src/client/runtime.js';
import type { BoltTransport } from '../../src/client.js';
import { setWorkspaceSession } from '#lib/client/session.js';

/**
 * Starting the replica: what it refuses to record, and how much it will hold while it records it.
 *
 * Two properties are pinned here, and both are about the replica declining to be confidently wrong.
 * A snapshot page it could not read is not the end of a collection, so a truncated database is never
 * stamped as the workspace. And an SSE stream that outruns PGlite does not become an unbounded array
 * in the tab: intake stops, and the durable cursor is what makes stopping safe.
 */

const REPLICA_STEPS = [
	{
		id: 'bolt:schema-state',
		sql: `create table bolt_schema_state (
			id uuid not null default '00000000-0000-0000-0000-000000000001',
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			fingerprint text not null,
			applied_at timestamptz not null default current_timestamp
		)`
	},
	{
		id: 'bolt:sync-horizon',
		sql: `create table bolt_sync_horizon (
			id uuid not null default '00000000-0000-0000-0000-000000000002',
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			singleton boolean primary key,
			xid bigint not null default 0,
			sequence bigint not null default 0
		)`
	},
	{
		id: 'collection:job-assignments',
		sql: `create table job_assignments (
			id uuid primary key,
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			title text
		)`
	}
];

const PROVISIONING: Schema.Json = {
	steps: REPLICA_STEPS,
	fingerprint: 'bootstrap-v1',
	collections: [
		{
			name: 'job_assignments',
			fields: { title: { type: 'string', required: false, indexed: false } },
			readableFields: null
		}
	],
	relations: []
};

const rid = (index: number): string =>
	`019f7a10-2000-7000-8000-${String(index).padStart(12, '0')}`;

/** One `sync.snapshot` answer, exactly as the runtime command returns it. */
const page = (
	rows: ReadonlyArray<Schema.Json>,
	nextAfter: string | null
): Schema.Json => ({
	collection: 'job_assignments',
	rows,
	cursor: { xid: 0, sequence: 0 },
	nextAfter
});

const opened: Array<PGlite> = [];

const declareSession = (): void => {
	setWorkspaceSession({
		tenantId: 'bootstrap-test',
		environment: 'development',
		releaseId: 'local',
		accessScope: 'operator',
		credential: 'test-credential',
		transport: { command: async () => null },
		syncStreamUrl: '/sync',
		files: {
			store: async () => '',
			remove: async () => undefined,
			urlFor: (key) => key
		},
		chatDocuments: {
			store: async (_conversation, key, file) => ({
				storage_key: key,
				file_name: file.name,
				file_size: file.size,
				mime_type: file.type || 'application/octet-stream'
			}),
			remove: async () => undefined,
			urlFor: (_conversation, key) => key
		},
		operations: { read: async () => null, run: async () => null }
	});
};

// Every case here boots a real in-process PGlite and provisions it. Four vitest workers sharing a
// runner make that cross the default budget while meaning nothing about the code under test.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 30_000 });

beforeEach(declareSession);

afterEach(async () => {
	for (const database of opened.splice(0)) if (!database.closed) await database.close();
});

/** A transport whose `sync.snapshot` answers come from a scripted list of pages. */
const scriptedTransport = (
	pages: ReadonlyArray<Schema.Json>
): { readonly transport: BootstrapTransport; readonly served: () => number } => {
	let served = 0;
	return {
		served: () => served,
		transport: {
			command: (command) =>
				Effect.sync((): Schema.Json => {
					switch (command) {
						case 'sync.provisioning':
							return PROVISIONING;
						case 'sync.shape':
							return ['job_assignments'];
						case 'sync.snapshot': {
							const answer = pages[Math.min(served, pages.length - 1)] ?? null;
							served += 1;
							return answer;
						}
						default:
							throw new Error(`Unexpected command ${command}`);
					}
				})
		}
	};
};

const openReplica = async (transport: BootstrapTransport, database: PGlite) =>
	Effect.runPromise(openLocalDatabase(transport, () => Effect.succeed(adaptPGlite(database))));

const titles = async (database: PGlite): Promise<ReadonlyArray<string | null>> => {
	const result = await database.query<{ title: string | null }>(
		'select title from job_assignments order by title'
	);
	return result.rows.map((row) => row.title);
};

describe('bootstrapping the replica from a snapshot', () => {
	it('refuses to stamp a workspace whose mid-collection page could not be read', async () => {
		const database = await PGlite.create('memory://');
		opened.push(database);
		// The first page names more to come. The second is unreadable — a truncated body, an error
		// envelope, a release whose page shape moved. Silently treating it as the end of the collection
		// loaded half a workspace and then recorded that half as the whole one.
		const { transport, served } = scriptedTransport([
			page([{ id: rid(1), title: 'First' }], rid(1)),
			{ error: 'upstream closed the connection' }
		]);

		await expect(openReplica(transport, database)).rejects.toThrow(/job_assignments/);
		expect(served()).toBe(2);
		// Unstamped: the fingerprint over a partial database is what made every later session resume it.
		expect(await Effect.runPromise(readReplicaState(adaptPGlite(database)))).toBeUndefined();

		// A healthy server on the next visit rebuilds rather than resuming, because nothing was recorded.
		const healthy = scriptedTransport([
			page([{ id: rid(1), title: 'First' }], rid(1)),
			page([{ id: rid(2), title: 'Second' }], null)
		]);
		const replica = await openReplica(healthy.transport, database);
		expect(replica.resumed).toBe(false);
		expect(await titles(database)).toEqual(['First', 'Second']);
		expect(
			(await Effect.runPromise(readReplicaState(adaptPGlite(database))))?.fingerprint
		).toBe('bootstrap-v1');
	});

	it('treats a page that omits its paging key as unreadable rather than as the last page', async () => {
		const database = await PGlite.create('memory://');
		opened.push(database);
		// `nextAfter` is not optional on the wire: `sync.snapshot` always states either the next id or
		// `null`. A page missing it cannot mean "the collection is exhausted" — that is the one reading
		// an absent key was given, and it ended the collection at whatever had arrived so far.
		const { transport } = scriptedTransport([
			page([{ id: rid(1), title: 'First' }], rid(1)),
			{ collection: 'job_assignments', rows: [{ id: rid(2), title: 'Second' }] }
		]);

		await expect(openReplica(transport, database)).rejects.toThrow(/job_assignments/);
		expect(await Effect.runPromise(readReplicaState(adaptPGlite(database)))).toBeUndefined();
	});

	it('keeps the rows of a page whose neighbour was masked out of its own id', async () => {
		const database = await PGlite.create('memory://');
		opened.push(database);
		// A field-restricted subject can be masked out of `id` itself, and a row no upsert can key is
		// not a reason to abandon the page's good ones. The envelope is what must be well formed.
		const { transport } = scriptedTransport([
			page([{ id: rid(1), title: 'First' }, { title: 'Unkeyable' }], null)
		]);

		const replica = await openReplica(transport, database);
		expect(replica.rows).toBeGreaterThan(0);
		expect(await titles(database)).toEqual(['First']);
	});

	it('withdraws the fingerprint while a resnapshot rebuilds behind it', async () => {
		const database = await PGlite.create('memory://');
		opened.push(database);
		const pages: Array<Schema.Json> = [page([{ id: rid(1), title: 'First' }], null)];
		let served = 0;
		const transport: BootstrapTransport = {
			command: (command) =>
				Effect.sync((): Schema.Json => {
					switch (command) {
						case 'sync.provisioning':
							return PROVISIONING;
						case 'sync.shape':
							return ['job_assignments'];
						case 'sync.snapshot': {
							const answer = pages[Math.min(served, pages.length - 1)] ?? null;
							served += 1;
							return answer;
						}
						default:
							throw new Error(`Unexpected command ${command}`);
					}
				})
		};

		const replica = await openReplica(transport, database);
		expect(replica.resumed).toBe(false);

		// A repair that empties the tables and then fails to refill them leaves exactly the projection
		// the first test refuses to create. It must not be wearing the fingerprint when it does.
		pages.push({ error: 'upstream closed the connection' });
		served = 1;
		await expect(Effect.runPromise(replica.resnapshot())).rejects.toThrow(/job_assignments/);
		expect(await Effect.runPromise(readReplicaState(adaptPGlite(database)))).toBeUndefined();
	});
});

/** A stub `EventSource` that records what the runtime opened, and what it closed. */
class StreamStub {
	static readonly opened: Array<StreamStub> = [];
	closed = false;
	readonly url: string;
	readonly #listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
	onerror: ((event: unknown) => void) | null = null;

	constructor(url: string, _options?: EventSourceInit) {
		this.url = url;
		StreamStub.opened.push(this);
	}

	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	close(): void {
		this.closed = true;
		this.#listeners.clear();
	}

	emit(type: string, data = ''): void {
		for (const listener of this.#listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }));
		}
	}

	/** The cursor this stream presented to the host, which is what the server would replay from. */
	cursor(): { readonly xid: number; readonly sequence: number } {
		return JSON.parse(new URL(this.url, 'https://host.invalid').searchParams.get('cursor') ?? '');
	}
}

describe('the replica apply queue', () => {
	it('stops reading the stream when the apply queue fills, and resumes from what it applied', async () => {
		StreamStub.opened.length = 0;
		vi.stubGlobal('EventSource', StreamStub);
		const database = await PGlite.create('memory://');
		opened.push(database);

		// PGlite is held closed so the apply loop cannot drain, which is the condition the browser is
		// actually in during a large catch-up: frames arrive far faster than a WASM Postgres commits.
		let hold: Promise<void> | undefined;
		let release: () => void = () => undefined;
		const base = adaptPGlite(database);
		const engine: PGliteLike = {
			...base,
			query: <T>(sql: string, parameters?: ReadonlyArray<unknown>) =>
				Effect.promise(() => hold ?? Promise.resolve()).pipe(
					Effect.flatMap(() => base.query<T>(sql, parameters))
				)
		};

		const transport: BoltTransport = {
			command: async (command): Promise<Schema.Json> => {
				switch (command) {
					case 'sync.provisioning':
						return PROVISIONING;
					case 'sync.shape':
						return ['job_assignments'];
					case 'sync.snapshot':
						return page([{ id: rid(1), title: 'change-0' }], null);
					default:
						throw new Error(`Unexpected command ${command}`);
				}
			}
		};

		const runtime = createBrowserWorkspaceRuntime({ transport });
		const errors: Array<unknown> = [];
		const starting = startLocalReplica(runtime, () => Effect.succeed(engine), {
			onError: (cause) => errors.push(cause)
		});
		await vi.waitFor(() => expect(StreamStub.opened).toHaveLength(1), { timeout: 20_000 });
		const first = StreamStub.opened[0];
		if (first === undefined) throw new Error('the leader opened no stream');
		first.emit('ready');
		const replica = await starting;

		try {
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const frame = (sequence: number): string =>
				JSON.stringify([
					{
						cursor: { xid: 1, sequence },
						collection: 'job_assignments',
						recordId: rid(1),
						operation: 'update',
						record: { title: `change-${sequence}` }
					}
				]);

			// The host keeps emitting until the tab stops listening. An unbounded queue never does.
			let sent = 0;
			while (sent < 256 && !first.closed) {
				sent += 1;
				first.emit('sync', frame(sent));
			}
			expect(first.closed).toBe(true);
			expect(sent).toBeLessThanOrEqual(128);

			// The tail the paused tab never saw. A closed EventSource delivers nothing, which is exactly
			// what makes the durable cursor — not the in-memory queue — responsible for not losing it.
			const total = sent + 16;
			for (let sequence = sent + 1; sequence <= total; sequence += 1) {
				first.emit('sync', frame(sequence));
			}

			release();
			await vi.waitFor(() => expect(StreamStub.opened).toHaveLength(2), { timeout: 10_000 });
			const second = StreamStub.opened[1];
			if (second === undefined) throw new Error('the drained leader reopened no stream');
			// Resumed from what landed in PGlite, so the replay covers every frame the pause dropped.
			const resumed = second.cursor();
			expect(resumed.xid).toBe(1);
			expect(resumed.sequence).toBeGreaterThan(0);
			expect(resumed.sequence).toBeLessThanOrEqual(sent);
			for (let sequence = resumed.sequence + 1; sequence <= total; sequence += 1) {
				second.emit('sync', frame(sequence));
			}

			await expect
				.poll(() => titles(database), { timeout: 10_000 })
				.toEqual([`change-${total}`]);
			expect(errors).toEqual([]);
		} finally {
			release();
			replica.stop();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});
});
