/**
 * Host change-feed wake. The writer is the host; after `sync_outbox` commits it
 * publishes. SSE waiters subscribe here. The guest never listens, and the host
 * never LISTENs on the tenant database.
 */
import type { DbQueryConfig, DbQueryInput, HostDbBinding } from '@norbital-ai/platform-utils/runtime/binding';

export type SyncWakeBus = {
	wakeSync(orgId: string, seq: string): void;
	subscribeSyncWake(orgId: string, onWake: (seq: string) => void): () => void;
	lastSyncSeq(orgId: string): string | null;
};

function seqAtLeast(left: string, right: string): boolean {
	try {
		return BigInt(left) >= BigInt(right);
	} catch {
		return left >= right;
	}
}

/** True when the client's cursor is already at the host-cached seq — do not query the tenant DB. */
export function cursorMatchesLastSeq(cursor: string | null | undefined, lastSeq: string | null): boolean {
	if (!cursor || lastSeq == null) return false;
	const seq = decodeCursorSeq(cursor);
	return seq != null && seqAtLeast(seq, lastSeq);
}

export function decodeCursorSeq(cursor: string): string | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (typeof parsed !== 'object' || parsed == null) return null;
		const seq = Reflect.get(parsed, 'seq');
		return typeof seq === 'string' && seq.length > 0 ? seq : null;
	} catch {
		return null;
	}
}

/** In-process bus. Self-host and tests. Core uses a Redis adapter with the same shape. */
export function createInProcessSyncWakeBus(): SyncWakeBus {
	const listeners = new Map<string, Set<(seq: string) => void>>();
	const last = new Map<string, string>();
	return {
		wakeSync(orgId, seq) {
			const previous = last.get(orgId);
			if (previous == null || seqAtLeast(seq, previous)) last.set(orgId, seq);
			for (const listener of listeners.get(orgId) ?? []) listener(seq);
		},
		subscribeSyncWake(orgId, onWake) {
			let set = listeners.get(orgId);
			if (!set) {
				set = new Set();
				listeners.set(orgId, set);
			}
			set.add(onWake);
			return () => {
				set.delete(onWake);
				if (set.size === 0) listeners.delete(orgId);
			};
		},
		lastSyncSeq(orgId) {
			return last.get(orgId) ?? null;
		}
	};
}

/** True when a tenant SQL statement appended the change feed. */
export function sqlWritesSyncOutbox(sql: string): boolean {
	return /insert\s+into\s+"?sync_outbox"?/i.test(sql);
}

function queryText(input: DbQueryInput): string {
	return typeof input === 'string' ? input : input.text;
}

function statementsWriteSyncOutbox(statements: readonly DbQueryConfig[]): boolean {
	return statements.some((statement) => sqlWritesSyncOutbox(statement.text));
}

/**
 * After a committed `sync_outbox` write, read the highest seq on the same binding and publish.
 * Transactional inserts wake on `commit`, not on the insert — the same moment NOTIFY used to fire.
 */
export function attachSyncWakeToDb<T extends HostDbBinding>(
	db: T,
	bus: SyncWakeBus,
	orgId: string
): T {
	const query = db.query.bind(db);
	const begin = db.begin.bind(db);
	const txQuery = db.txQuery.bind(db);
	const commit = db.commit.bind(db);
	const rollback = db.rollback.bind(db);
	const batch = db.batch.bind(db);
	const txBatch = db.txBatch.bind(db);
	const dirtyTransactions = new Set<string>();
	const publish = async (): Promise<void> => {
		const result = await query(`SELECT MAX(seq)::text AS seq FROM sync_outbox`);
		const row = result.rows[0];
		const seq = row && typeof row === 'object' ? Reflect.get(row, 'seq') : null;
		if (typeof seq === 'string' && seq.length > 0) bus.wakeSync(orgId, seq);
	};
	const extras = db as T & { validate?: () => Promise<void>; close?: () => Promise<void> };
	return {
		...db,
		...(typeof extras.validate === 'function' ? { validate: extras.validate.bind(db) } : {}),
		...(typeof extras.close === 'function' ? { close: extras.close.bind(db) } : {}),
		query: async (sql, params) => {
			const result = await query(sql, params);
			if (sqlWritesSyncOutbox(queryText(sql))) await publish();
			return result;
		},
		begin,
		txQuery: async (transactionId, sql, params) => {
			const result = await txQuery(transactionId, sql, params);
			if (sqlWritesSyncOutbox(queryText(sql))) dirtyTransactions.add(transactionId);
			return result;
		},
		commit: async (transactionId) => {
			const dirty = dirtyTransactions.delete(transactionId);
			await commit(transactionId);
			if (dirty) await publish();
		},
		rollback: async (transactionId) => {
			dirtyTransactions.delete(transactionId);
			await rollback(transactionId);
		},
		batch: async (statements) => {
			const result = await batch(statements);
			if (statementsWriteSyncOutbox(statements)) await publish();
			return result;
		},
		txBatch: async (transactionId, statements) => {
			const result = await txBatch(transactionId, statements);
			if (statementsWriteSyncOutbox(statements)) dirtyTransactions.add(transactionId);
			return result;
		}
	};
}
