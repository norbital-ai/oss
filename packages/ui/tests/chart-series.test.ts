import { describe, expect, it } from '@effect/vitest';
import { series } from '../src/chart/series.ts';

describe('chart series extraction', () => {
	it('unwraps money objects on plain and aggregated rows without producing NaN', () => {
		const agg = series(
			{
				rows: [
					{ key: { status: 'posted' }, count: 2, sum: { amount: { amount: '1250.50', currency: 'USD' } } },
					{ key: { status: 'draft' }, count: 1, sum: { amount: { amount: 400, currency: 'USD' } } },
					{ key: { status: 'void' }, count: 0, sum: { amount: null } }
				],
				next: null
			},
			'status',
			['count', 'sum.amount']
		);
		expect(agg).toEqual([
			{ status: 'posted', count: 2, 'sum.amount': 1250.5 },
			{ status: 'draft', count: 1, 'sum.amount': 400 },
			{ status: 'void', count: 0, 'sum.amount': null }
		]);
	});

	it('labels a model chart category by its catalog name and leaves unnamed values as they are', () => {
		const t = (key: string) =>
			key === 'models.docs.fields.kind.delivery_order' ? 'Delivery Order (DO)' : key;
		const rows = series(
			{
				rows: [
					{ key: { kind: 'delivery_order' }, count: 2 },
					{ key: { kind: 'invoice' }, count: 1 }
				],
				next: null
			},
			'kind',
			['count'],
			{ t, model: 'docs', field: 'kind' }
		);
		expect(rows).toEqual([
			{ kind: 'Delivery Order (DO)', count: 2 },
			{ kind: 'invoice', count: 1 }
		]);
	});

	it('extracts money fields from direct record rows and maps non-numeric values to null', () => {
		const rows = series(
			[
				{ name: 'Operating', balance: { amount: '98000.25', currency: 'SGD' } },
				{ name: 'Reserve', balance: 'not-a-number' }
			],
			'name',
			['balance']
		);
		expect(rows).toEqual([
			{ name: 'Operating', balance: 98000.25 },
			{ name: 'Reserve', balance: null }
		]);
	});
});
