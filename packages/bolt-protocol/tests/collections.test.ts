import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { CollectionCreateRequest, storedRecordsOf } from '../src/index.js';

/**
 * The two halves of the collection write contract, held against the shape both ends are written to.
 *
 * `storedRecordsOf` is the one that earns a test on its own. The client fails when it returns
 * `undefined`, so the difference between "unrecognised" and "empty" is load bearing: a reader that
 * answered `[]` for a shape it did not understand would turn a protocol mismatch into a successful
 * write that returned no record, which is indistinguishable from a legitimate result and is
 * therefore never investigated.
 */
describe('the create request', () => {
	it('accepts a body with no id, because the server assigns it', () => {
		expect(
			Schema.is(CollectionCreateRequest)({
				collection: 'orders',
				values: { reference: 'ORD-1' }
			})
		).toBe(true);
	});

	it('accepts a nested graph, because that is what a create body may carry', () => {
		expect(
			Schema.is(CollectionCreateRequest)({
				collection: 'orders',
				values: {
					reference: 'ORD-1',
					order_line_order: [{ sku: 'a-1' }, { sku: 'a-2', components: [{ part: 'p-1' }] }]
				}
			})
		).toBe(true);
	});

	it('still requires the collection', () => {
		expect(Schema.is(CollectionCreateRequest)({ values: { reference: 'ORD-1' } })).toBe(false);
		expect(Schema.is(CollectionCreateRequest)({ collection: '', values: {} })).toBe(false);
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
