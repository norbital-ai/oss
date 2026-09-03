import { describe, expect, it } from 'vitest';
import { collectionQuery } from '../src/runtime/dispatch.js';

/**
 * The command boundary rebuilds a collection query field by field, so a field it does not name is
 * dropped with no error raised anywhere: the client sends it, the server never sees it, and the
 * only symptom is a surface quietly rendering less than it asked for. That is how `where`/`orderBy`
 * were lost, and then `with` — a table asked for its relations and rendered raw uuids instead.
 */
describe('collection query boundary', () => {
	it('carries every query field across', () => {
		const query = collectionQuery({
			collection: 'component_entries',
			where: { repayment_agreement_id: { isNull: true } },
			orderBy: { event_date: 'desc' },
			with: { entry_pay_component: { columns: { code: true } } },
			search: { mode: 'lexical', term: 'loan' },
			after: 'cursor-token',
			limit: 25
		});
		expect(query).toEqual({
			collection: 'component_entries',
			limit: 25,
			where: { repayment_agreement_id: { isNull: true } },
			orderBy: { event_date: 'desc' },
			with: { entry_pay_component: { columns: { code: true } } },
			search: { mode: 'lexical', term: 'loan' },
			after: 'cursor-token'
		});
	});

	it('does not forward a projection the read path cannot honour', () => {
		// `columns` is accepted on the wire and left here on purpose: selecting fewer columns would strip
		// the ordering columns the cursor is cut from. Half-wiring it would break paging, not narrow it.
		expect(collectionQuery({ collection: 'people', columns: { name: true } })).toEqual({
			collection: 'people',
			limit: 100
		});
	});

	it('omits what was not asked for rather than sending an undefined through', () => {
		expect(collectionQuery({ collection: 'people' })).toEqual({
			collection: 'people',
			limit: 100
		});
	});

	it('clamps the page to the boundary ceiling in both directions', () => {
		expect(collectionQuery({ collection: 'people', limit: 100_000 }).limit).toBe(500);
		expect(collectionQuery({ collection: 'people', limit: 0 }).limit).toBe(1);
	});
});
