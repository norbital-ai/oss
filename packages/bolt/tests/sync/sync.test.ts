import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	decodeDatabaseSyncCursor,
	SyncCursor,
	SyncPartitionDelta
} from '../../src/runtime/sync/sync.js';

describe('Sync owner', () => {
	it('decodes ordered xid/sequence cursors', () =>
		expect(Schema.decodeUnknownSync(SyncCursor)({ xid: 4, sequence: 9 })).toEqual({
			xid: 4,
			sequence: 9
		}));
	it('rejects malformed replication changes', () =>
		expect(() =>
			Schema.decodeUnknownSync(SyncPartitionDelta)({
				cursor: {},
				collection: '',
				recordId: '',
				op: 'oops'
			})
		).toThrow());
	it('normalizes PostgreSQL bigint cursor fields without widening the wire schema', async () => {
		expect(await Effect.runPromise(decodeDatabaseSyncCursor({ xid: '42', sequence: '7' }))).toEqual(
			{
				xid: 42,
				sequence: 7
			}
		);
		expect(() => Schema.decodeUnknownSync(SyncCursor)({ xid: '42', sequence: '7' })).toThrow();
	});
});
