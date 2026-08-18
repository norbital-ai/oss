import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncChange, SyncCursor } from '../../src/runtime/sync/sync.js';

describe('Sync owner', () => {
	it('decodes ordered xid/sequence cursors', () =>
		expect(Schema.decodeUnknownSync(SyncCursor)({ xid: 4, sequence: 9 })).toEqual({
			xid: 4,
			sequence: 9
		}));
	it('rejects malformed replication changes', () =>
		expect(() =>
			Schema.decodeUnknownSync(SyncChange)({
				cursor: {},
				collection: '',
				recordId: '',
				operation: 'oops'
			})
		).toThrow());
});
