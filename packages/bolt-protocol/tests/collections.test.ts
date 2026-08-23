import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	CollectionMutateRequest,
	CollectionPendingApproval,
	CollectionWriteResult,
	pendingApprovalOf,
	storedRecordsOf
} from '../src/index.js';

/**
 * The two halves of the collection write contract, held against the shape both ends are written to.
 *
 * `storedRecordsOf` is the one that earns a test on its own. The client fails when it returns
 * `undefined`, so the difference between "unrecognised" and "empty" is load bearing: a reader that
 * answered `[]` for a shape it did not understand would turn a protocol mismatch into a successful
 * write that returned no record, which is indistinguishable from a legitimate result and is
 * therefore never investigated.
 */
describe('the declarative mutation request', () => {
	it('accepts a new root with no id, because the server assigns it', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				collection: 'orders',
				values: { reference: 'ORD-1' }
			})
		).toBe(true);
	});

	it('accepts identities at every graph level so present rows can be synchronized', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				collection: 'orders',
				values: {
					id: 'order-1',
					reference: 'ORD-1',
					order_line_order: [
						{ id: 'line-1', sku: 'a-1' },
						{ sku: 'a-2', components: [{ id: 'component-1', part: 'p-1' }] }
					]
				}
			})
		).toBe(true);
	});

	it('still requires the collection', () => {
		expect(Schema.is(CollectionMutateRequest)({ values: { reference: 'ORD-1' } })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ collection: '', values: {} })).toBe(false);
	});

	it('uses the exact stored-record response envelope', () => {
		expect(Schema.is(CollectionWriteResult)({ records: [{ id: 'order-1' }] })).toBe(true);
		expect(Schema.is(CollectionWriteResult)({ record: { id: 'order-1' } })).toBe(false);
		expect(Schema.is(CollectionWriteResult)({ records: { id: 'order-1' } })).toBe(false);
	});

	it('recognizes an HTTP 202 approval outcome as a distinct successful response', () => {
		const pending = {
			pending: true,
			requestId: 'approval-1',
			collection: 'orders',
			id: 'order-1',
			action: 'update'
		} as const;
		expect(Schema.is(CollectionPendingApproval)(pending)).toBe(true);
		expect(pendingApprovalOf(pending)).toEqual(pending);
		expect(pendingApprovalOf({ records: [{ id: 'order-1' }] })).toBeUndefined();
	});
});

describe('storedRecordsOf', () => {
	it('reads the rows out of a write response', () => {
		expect(storedRecordsOf({ created: true, records: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
	});

	it('reads an empty result as empty, not as unrecognised', () => {
		expect(storedRecordsOf({ updated: true, records: [] })).toEqual([]);
	});

	it('returns undefined for a response that carries no records at all', () => {
		expect(storedRecordsOf({ created: true, id: 'a' })).toBeUndefined();
	});

	it('returns undefined rather than guessing at a shape it does not recognise', () => {
		expect(storedRecordsOf(null)).toBeUndefined();
		expect(storedRecordsOf('records')).toBeUndefined();
		expect(storedRecordsOf([{ id: 'a' }])).toBeUndefined();
		expect(storedRecordsOf({ records: {} })).toBeUndefined();
		// A list of things that are not rows is the case worth naming: it is the shape closest to
		// correct, so it is the one a lenient reader would let through as data.
		expect(storedRecordsOf({ records: ['a'] })).toBeUndefined();
		expect(storedRecordsOf({ records: [null] })).toBeUndefined();
		expect(storedRecordsOf({ records: [['a']] })).toBeUndefined();
	});
});
