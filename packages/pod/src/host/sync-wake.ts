/**
 * Host change-feed wake. The writer is the host; after `sync_outbox` commits it
 * publishes. SSE waiters subscribe here. The guest never listens, and the host
 * never LISTENs on the tenant database.
 */
import type {
	DbQueryConfig,
	DbQueryInput,
	HostDbBinding
} from '@norbital-ai/platform-utils/runtime/binding';

export type SyncWakeBus = {
	wakeSync(orgId: string): void;
	subscribeSyncWake(orgId: string, onWake: () => void): () => void;
};

/** In-process bus. Self-host and tests. Core uses a Redis adapter with the same shape. */
export function createInProcessSyncWakeBus(): SyncWakeBus {
	const listeners = new Map<string, Set<() => void>>();
	return {
		wakeSync(orgId) {
			for (const listener of listeners.get(orgId) ?? []) listener();
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

/** Publish after commit. The durable cursor stays in Postgres; a wake carries no ordering state. */
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
	const publish = () => bus.wakeSync(orgId);
	const extras = db as T & { validate?: () => Promise<void>; close?: () => Promise<void> };
	return {
		...db,
		...(typeof extras.validate === 'function' ? { validate: extras.validate.bind(db) } : {}),
		...(typeof extras.close === 'function' ? { close: extras.close.bind(db) } : {}),
		query: async (sql, params) => {
			const result = await query(sql, params);
			if (sqlWritesSyncOutbox(queryText(sql))) publish();
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
			if (dirty) publish();
		},
		rollback: async (transactionId) => {
			dirtyTransactions.delete(transactionId);
			await rollback(transactionId);
		},
		batch: async (statements) => {
			const result = await batch(statements);
			if (statementsWriteSyncOutbox(statements)) publish();
			return result;
		},
		txBatch: async (transactionId, statements) => {
			const result = await txBatch(transactionId, statements);
			if (statementsWriteSyncOutbox(statements)) dirtyTransactions.add(transactionId);
			return result;
		}
	};
}
