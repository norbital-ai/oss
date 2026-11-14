// A same-graph database adapter crosses HOST_API as complete SQL batches with owned cancellation.
import { Effect } from 'effect';
import type { HostTenantDb, RawDb } from '../../index.ts';

/** A same-graph `RawDb` as the Host API's Promise-based `HostTenantDb`; aborting `signal` interrupts the batch. */
export const tenant_db_port = (db: RawDb): HostTenantDb => ({
	read: (statements, signal) => Effect.runPromise(db.read(statements), { signal }),
	write: (statement, lock, signal) => Effect.runPromise(db.write(statement, lock), { signal }),
	transaction: (batch, signal) => Effect.runPromise(db.transaction(batch), { signal })
});
