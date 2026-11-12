import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
	AI_USAGE_METER_ID,
	BILLING_CURRENCY,
	BillingCataloguePlanSchema,
	BillingCataloguePriceSchema,
	BillingCatalogueSchema,
	LATEST_CATALOGUE_PRODUCTS,
	USAGE_METER_IDS,
	calculate_catalogue_meter_cost_sgd_micros
} from '../src/billing/index.ts';

it('decodes the published snake_case catalogue and prices the units its meters report', () => {
	const catalogue = Schema.decodeUnknownSync(BillingCatalogueSchema, { onExcessProperty: 'error' })({
		currency: BILLING_CURRENCY,
		products: LATEST_CATALOGUE_PRODUCTS
	});
	const product = catalogue.products.find((entry) => entry.id === 'platform');
	if (product === undefined) throw new Error('The platform catalogue product is missing.');
	expect(product.plans).toEqual([{ id: 'platform', trial_days: 30, allow_promotion_codes: true }]);
	const ai = product.prices.find((price) => price.meter_id === AI_USAGE_METER_ID);
	if (ai === undefined) throw new Error('The AI meter price is missing.');
	expect(ai.unit_amount_decimal).toBe('0.0001');
	expect(typeof ai.stripe_price_ids.production).toBe('string');
	const plan = Schema.decodeUnknownResult(BillingCataloguePlanSchema, { onExcessProperty: 'error' });
	expect(
		plan({ id: 'platform', trial_days: 30, allow_promotion_codes: true, trialDays: 30 })._tag
	).toBe('Failure');
	const price = Schema.decodeUnknownResult(BillingCataloguePriceSchema, {
		onExcessProperty: 'error'
	});
	expect(price({ ...ai, meterId: AI_USAGE_METER_ID })._tag).toBe('Failure');
	expect(calculate_catalogue_meter_cost_sgd_micros(USAGE_METER_IDS.compute, 1_000)).toBe(500);
	expect(calculate_catalogue_meter_cost_sgd_micros(AI_USAGE_METER_ID, 1_000_000)).toBe(1_000_000);
	expect(() => calculate_catalogue_meter_cost_sgd_micros(AI_USAGE_METER_ID, -1)).toThrow();
	expect(() => calculate_catalogue_meter_cost_sgd_micros(AI_USAGE_METER_ID, 0.5)).toThrow();
});
