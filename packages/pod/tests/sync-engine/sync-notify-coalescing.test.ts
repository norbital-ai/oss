import { describe, it, expect } from 'vitest';
import type {
	DbQueryConfig,
	DbQueryInput,
	DbQueryResult,
	HostDbBinding
} from '@norbital-ai/platform-utils/runtime/binding';
import { attachSyncWakeToDb, createInProcessSyncWakeBus } from '../../src/host/sync-wake.js';
import { serveHostSyncStream } from '../../src/host/sync-stream.js';

function encodeCursor(cursor: { xid: string; seq: string }): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function result(rows: readonly unknown[]): DbQueryResult {
	return { rows, rowCount: rows.length };
}

function memoryDb(): HostDbBinding & { readonly statements: string[] } {
	let seq = 0;
	const statements: string[] = [];
	const textOf = (input: DbQueryInput) => (typeof input === 'string' ? input : input.text);
	const run = (input: DbQueryInput): DbQueryResult => {
		const text = textOf(input);
		statements.push(text);
		if (/insert\s+into\s+"?sync_outbox"?/i.test(text)) {
			seq += 1;
			return result([{ seq: String(seq) }]);
		}
		if (/max\(seq\)/i.test(text)) {
			return result(seq === 0 ? [{ seq: null }] : [{ seq: String(seq) }]);
		}
		return result([]);
	};
	return {
		statements,
		query: async (sql) => run(sql),
		begin: async () => 'tx-1',
		txQuery: async (_tx, sql) => run(sql),
		commit: async () => undefined,
		rollback: async () => undefined,
		batch: async (batchStatements: readonly DbQueryConfig[]) => batchStatements.map((s) => run(s)),
		txBatch: async (_tx, batchStatements) => batchStatements.map((s) => run(s))
	};
}

describe('host sync wake bus', () => {
	it('publishes one edge-only wake after a committed outbox insert', async () => {
		const bus = createInProcessSyncWakeBus();
		let wakes = 0;
		bus.subscribeSyncWake('org-a', () => (wakes += 1));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		await db.query('INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)');

		expect(wakes).toBe(1);
		expect(db.statements.some((statement) => /max\(seq\)/i.test(statement))).toBe(false);
	});

	it('wakes on commit, not on the transactional insert', async () => {
		const bus = createInProcessSyncWakeBus();
		let wakes = 0;
		bus.subscribeSyncWake('org-a', () => (wakes += 1));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		const tx = await db.begin();
		await db.txQuery(
			tx,
			'INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)'
		);
		expect(wakes).toBe(0);
		await db.commit(tx);
		expect(wakes).toBe(1);
	});

	it('does not wake a rolled-back outbox insert', async () => {
		const bus = createInProcessSyncWakeBus();
		let wakes = 0;
		bus.subscribeSyncWake('org-a', () => (wakes += 1));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		const tx = await db.begin();
		await db.txQuery(
			tx,
			'INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)'
		);
		await db.rollback(tx);
		expect(wakes).toBe(0);
	});

	it('does not cross orgs', () => {
		const bus = createInProcessSyncWakeBus();
		let a = 0;
		let b = 0;
		bus.subscribeSyncWake('org-a', () => (a += 1));
		bus.subscribeSyncWake('org-b', () => (b += 1));
		bus.wakeSync('org-a');
		expect(a).toBe(1);
		expect(b).toBe(0);
	});

	it('pulls the durable feed when a newer xid has a lower seq', async () => {
		const cursor = encodeCursor({ xid: '1', seq: '40' });
		let pulls = 0;
		const input = {
			path: `/_runtime/sync/stream?cursor=${cursor}&collection=chat_session`,
			// The retired shortcut consumed this scalar and slept forever. Keeping it on the test
			// object proves an old implementation fails while structural extra fields stay harmless.
			lastSeq: () => '50',
			pullDiff: async () => {
				pulls += 1;
				return pulls === 1
					? {
							status: 200,
							bodyText: JSON.stringify({
								type: 'diffs',
								diffs: [
									{
										seq: '30',
										xid: '2',
										collection: 'chat_session',
										action: 'update',
										id: 'chat-1',
										version: 2,
										row: { norbital_id: 'chat-1' }
									}
								],
								cursor: { xid: '2', seq: '30' }
							})
						}
					: {
							status: 200,
							bodyText: JSON.stringify({ type: 'idle', cursor: { xid: '2', seq: '30' } })
						};
			},
			subscribe: () => () => {}
		};
		const served = serveHostSyncStream(input);
		const reader = served.body.getReader();
		const decoder = new TextDecoder();
		let frames = '';
		try {
			while (!frames.includes('"id":"chat-1"')) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('stream did not pull the durable cursor')), 1_000)
					)
				]);
				if (chunk.done) break;
				frames += decoder.decode(chunk.value, { stream: true });
			}
			expect(pulls).toBeGreaterThan(0);
			expect(frames).toContain('"id":"chat-1"');
		} finally {
			served.cancel();
			await reader.cancel().catch(() => undefined);
		}
	});

	it('does not drop a wake delivered while a durable pull is in flight', async () => {
		let notify = () => {};
		let pulls = 0;
		const served = serveHostSyncStream({
			path: '/_runtime/sync/stream?collection=chat_session',
			pullDiff: async () => {
				pulls += 1;
				if (pulls === 1) notify();
				return pulls <= 21
					? {
							status: 200,
							bodyText: JSON.stringify({ type: 'idle', cursor: { xid: '1', seq: '1' } })
						}
					: {
							status: 200,
							bodyText: JSON.stringify({
								type: 'diffs',
								diffs: [
									{
										seq: '2',
										xid: '2',
										collection: 'chat_session',
										action: 'update',
										id: 'chat-after-wake',
										version: 2,
										row: { norbital_id: 'chat-after-wake' }
									}
								],
								cursor: { xid: '2', seq: '2' }
							})
						};
			},
			subscribe: (onWake) => {
				notify = onWake;
				return () => {};
			}
		});
		const reader = served.body.getReader();
		const decoder = new TextDecoder();
		let frames = '';
		try {
			while (!frames.includes('chat-after-wake')) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('wake was dropped before the stream slept')), 1_500)
					)
				]);
				if (chunk.done) break;
				frames += decoder.decode(chunk.value, { stream: true });
			}
			expect(frames).toContain('chat-after-wake');
		} finally {
			served.cancel();
			await reader.cancel().catch(() => undefined);
		}
	});
});
