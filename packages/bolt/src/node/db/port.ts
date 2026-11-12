// A same-graph TenantDb crosses HOST_API as complete SQL batches with owned cancellation.
import { Effect } from 'effect';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import type { HostTenantDb } from '../../protocol/host-api.ts';

export const tenant_db_port = (db: TenantDbShape): HostTenantDb => ({
	read: (statements, signal) => Effect.runPromise(db.read(statements), { signal }),
	write: (statement, lock, signal) => Effect.runPromise(db.write(statement, lock), { signal }),
	transaction: (batch, signal) => Effect.runPromise(db.transaction(batch), { signal })
});
