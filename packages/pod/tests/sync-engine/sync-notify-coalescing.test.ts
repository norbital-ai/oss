import { describe, it, expect } from 'vitest';
import type {
	DbQueryConfig,
	DbQueryInput,
	DbQueryResult,
	HostDbBinding
} from '@norbital-ai/platform-utils/runtime/binding';
import {
	attachSyncWakeToDb,
	createInProcessSyncWakeBus,
	cursorMatchesLastSeq,
	decodeCursorSeq
} from '../../src/host/sync-wake.js';

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
	it('publishes the highest seq after a committed outbox insert', async () => {
		const bus = createInProcessSyncWakeBus();
		const woken: string[] = [];
		bus.subscribeSyncWake('org-a', (seq) => woken.push(seq));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		await db.query('INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)');

		expect(woken).toEqual(['1']);
		expect(bus.lastSyncSeq('org-a')).toBe('1');
	});

	it('wakes on commit, not on the transactional insert', async () => {
		const bus = createInProcessSyncWakeBus();
		const woken: string[] = [];
		bus.subscribeSyncWake('org-a', (seq) => woken.push(seq));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		const tx = await db.begin();
		await db.txQuery(tx, 'INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)');
		expect(woken).toEqual([]);
		await db.commit(tx);
		expect(woken).toEqual(['1']);
	});

	it('does not wake a rolled-back outbox insert', async () => {
		const bus = createInProcessSyncWakeBus();
		const woken: string[] = [];
		bus.subscribeSyncWake('org-a', (seq) => woken.push(seq));
		const db = attachSyncWakeToDb(memoryDb(), bus, 'org-a');

		const tx = await db.begin();
		await db.txQuery(tx, 'INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1, $2, $3)');
		await db.rollback(tx);
		expect(woken).toEqual([]);
		expect(bus.lastSyncSeq('org-a')).toBeNull();
	});

	it('does not cross orgs', () => {
		const bus = createInProcessSyncWakeBus();
		const a: string[] = [];
		const b: string[] = [];
		bus.subscribeSyncWake('org-a', (seq) => a.push(seq));
		bus.subscribeSyncWake('org-b', (seq) => b.push(seq));
		bus.wakeSync('org-a', '9');
		expect(a).toEqual(['9']);
		expect(b).toEqual([]);
	});

	it('skips a tenant-DB pull when the cursor is already at the cached seq', () => {
		const cursor = encodeCursor({ xid: '1', seq: '40' });
		expect(decodeCursorSeq(cursor)).toBe('40');
		expect(cursorMatchesLastSeq(cursor, '40')).toBe(true);
		expect(cursorMatchesLastSeq(cursor, '41')).toBe(false);
		expect(cursorMatchesLastSeq(null, '40')).toBe(false);
	});
});
