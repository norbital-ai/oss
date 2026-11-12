// repository-health:allow SEM_PARALLEL -- index is the barrel over rate-card and schemas; the public surface, not a second implementation.
import type {
	BillingCataloguePrice,
	BillingCatalogueProduct
} from './schemas.js';
import {
	AI_SGD_PER_PROVIDER_USD,
	COMPUTE_SGD_PER_SECOND,
	DISC_SGD_PER_GB_MONTH,
	FILES_SGD_PER_GB_MONTH,
	HOURS_PER_BILLING_MONTH
} from './rate-card.js';

/** The trial length of the platform plan, in days. */
export const DEFAULT_BILLING_TRIAL_DAYS = 30;
/** Cents per dollar of the billing currency. */
export const CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT = 100;
/** The id of the platform product and of its one plan in the catalogue. */
export const PLATFORM_PRODUCT_ID = 'platform';

/** The meter AI usage is reported to, in micro-SGD of converted provider cost. */
export const AI_USAGE_METER_ID = 'bolt_ai_cost_sgd_micros_v1';

function stripeDecimalCents(sgdPerUnit: number): string {
	return (sgdPerUnit * CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT)
		.toFixed(12)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
}

const MILLISECONDS_PER_SECOND = 1_000;
const MICRO_UNITS_PER_GB_HOUR = 1_000_000;

const USAGE_METER_UNIT_AMOUNT_CENTS = {
	compute: stripeDecimalCents(COMPUTE_SGD_PER_SECOND / MILLISECONDS_PER_SECOND),
	disc: stripeDecimalCents(
		DISC_SGD_PER_GB_MONTH / HOURS_PER_BILLING_MONTH / MICRO_UNITS_PER_GB_HOUR
	),
	files: stripeDecimalCents(
		FILES_SGD_PER_GB_MONTH / HOURS_PER_BILLING_MONTH / MICRO_UNITS_PER_GB_HOUR
	)
} as const;

/** The meter id of each metered usage: compute, disc, files and AI. */
export const USAGE_METER_IDS = {
	compute: 'bolt_compute_seconds_v1',
	disc: 'bolt_disc_gb_hours_v1',
	files: 'bolt_files_gb_hours_v1',
	ai: AI_USAGE_METER_ID
} as const;

/**
 * What a tenant owes for one turn, in micro-SGD, given what the provider charged for it in USD.
 *
 * The single conversion for AI spend: the ledger prices an observation with it, the Stripe meter
 * reports the quantity it returns, and the agent panel shows a conversation's total through it.
 */
export function ai_provider_cost_sgd_micros(providerCostUsd: number): number {
	if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
		throw new Error('AI provider cost must be a finite non-negative USD amount');
	}
	return Math.round(providerCostUsd * AI_SGD_PER_PROVIDER_USD * 1_000_000);
}

/**
 * The flat platform fee, per workspace, per month, as a real Stripe price. Checkout subscribes it
 * as `line_items[0]` with the metered prices after it, so the base is invoiced on the same
 * subscription as the usage it gates. `amount` is major units, the figure the pricing page reads.
 */
export const PLATFORM_FLAT_PRICES = [
	{
		id: 'platform-base-monthly',
		name: 'Workspace base',
		description: 'SGD 10.00 per workspace per month, flat — unchanged by headcount or usage.',
		model: 'flat',
		interval: 'month',
		checkout: true,
		stripe_price_ids: {
			sandbox: 'price_1U97ONLvWjJB44nUrKDVveY3',
			production: null
		},
		amount: '10.00'
	}
] as const satisfies readonly BillingCataloguePrice[];

/** The flat base fee in major units — the catalogue amount, not a second literal beside it. */
export const PLATFORM_BASE_SGD_PER_MONTH = Number(PLATFORM_FLAT_PRICES[0].amount);

/** The metered AI usage price: provider cost converted to micro-SGD at the published rate. */
export const AI_METERED_PRICES = [
	{
		id: 'ai-provider-cost-micros-monthly',
		name: 'AI usage',
		description:
			'Provider-reported request cost converted from USD to micro-SGD at the published billing rate, which loads provider credit fees, FX, payment processing and margin onto the conversion. Token counts and model remain attached to every event for audit.',
		model: 'metered',
		meter_id: AI_USAGE_METER_ID,
		stripe_price_ids: {
			sandbox: 'price_1Ty8XqLvWjJB44nUyTvOAuYp',
			production: 'price_1TyCvvLlQVSVzCBMS9rUyU0V'
		},
		unit_amount_decimal: '0.0001',
		interval: 'month',
		checkout: true
	}
] as const satisfies readonly BillingCataloguePrice[];

/**
 * The current catalogue's products: the platform product with its flat base fee and its compute, disc, files and AI meters.
 */
export const LATEST_CATALOGUE_PRODUCTS = [
	{
		id: PLATFORM_PRODUCT_ID,
		name: 'Norbital Platform',
		description:
			'A flat base fee per workspace, plus separately metered compute, disc, files, and AI usage.',
		prices: [
			...PLATFORM_FLAT_PRICES,
			{
				id: 'compute-second-monthly',
				name: 'Compute usage',
				description:
					'SGD 0.0005 per worker-thread ELU active second. Memory infrastructure cost is included in the price; memory is not separately metered or hard-walled per worker. Stripe records milliseconds.',
				model: 'metered',
				meter_id: USAGE_METER_IDS.compute,
				interval: 'month',
				checkout: true,
				stripe_price_ids: {
					sandbox: 'price_1U5gO4LvWjJB44nUCUzkwD61',
					production: 'price_1U5gPrLlQVSVzCBMefEfyUnM'
				},
				unit_amount_decimal: USAGE_METER_UNIT_AMOUNT_CENTS.compute
			},
			{
				id: 'disc-gb-hour-monthly',
				name: 'Disc usage',
				description: 'SGD 3.00 per GB-month for tenant database storage, measured in GB-hours.',
				model: 'metered',
				meter_id: USAGE_METER_IDS.disc,
				interval: 'month',
				checkout: true,
				stripe_price_ids: {
					sandbox: 'price_1U5gOQLvWjJB44nUkHqcqjGn',
					production: 'price_1U5gPrLlQVSVzCBM3ctzic6b'
				},
				unit_amount_decimal: USAGE_METER_UNIT_AMOUNT_CENTS.disc
			},
			{
				id: 'files-gb-hour-monthly',
				name: 'Files usage',
				description: 'SGD 0.25 per GB-month for tenant object storage, measured in GB-hours.',
				model: 'metered',
				meter_id: USAGE_METER_IDS.files,
				interval: 'month',
				checkout: true,
				stripe_price_ids: {
					sandbox: 'price_1U5gORLvWjJB44nUzycz1ITJ',
					production: 'price_1U5gPsLlQVSVzCBMHKfK5Ker'
				},
				unit_amount_decimal: USAGE_METER_UNIT_AMOUNT_CENTS.files
			},
			...AI_METERED_PRICES
		],
		plans: [
			{
				id: PLATFORM_PRODUCT_ID,
				trial_days: DEFAULT_BILLING_TRIAL_DAYS,
				allow_promotion_codes: true
			}
		]
	}
] as const satisfies readonly BillingCatalogueProduct[];

/** Every price of the current catalogue. */
export const LATEST_CATALOGUE_PRICES = LATEST_CATALOGUE_PRODUCTS[0]
	.prices as readonly BillingCataloguePrice[];

/**
 * The cost in micro-SGD of `quantity` units of a meter at the current catalogue's unit price; throws on a negative or fractional quantity or an unknown meter.
 */
export function calculate_catalogue_meter_cost_sgd_micros(meter_id: string, quantity: number): number {
	if (!Number.isSafeInteger(quantity) || quantity < 0) {
		throw new Error('Meter quantity must be a non-negative safe integer');
	}
	const price = LATEST_CATALOGUE_PRICES.find((candidate) => candidate.meter_id === meter_id);
	if (!price?.unit_amount_decimal) {
		throw new Error(`Catalogue meter price is missing for ${meter_id}`);
	}
	return Math.round(quantity * Number(price.unit_amount_decimal) * 10_000);
}

export {
	AI_SGD_PER_PROVIDER_USD,
	BILLING_ACCESS_TIERS,
	BILLING_CURRENCY,
	COMPUTE_SGD_PER_SECOND,
	DISC_SGD_PER_GB_MONTH,
	FILES_SGD_PER_GB_MONTH,
	HOURS_PER_BILLING_MONTH,
	type BillingAccessTier
} from './rate-card.js';

export {
	BillingCatalogueIntervalSchema,
	BillingCataloguePlanSchema,
	BillingCataloguePriceModelSchema,
	BillingCataloguePriceSchema,
	BillingCatalogueProductSchema,
	BillingCatalogueProviderPriceIdsSchema,
	BillingCatalogueSchema,
	BillingCatalogueTierSchema,
	BillingProviderEnvironmentSchema,
	type BillingCatalogue,
	type BillingCatalogueInterval,
	type BillingCataloguePlan,
	type BillingCataloguePrice,
	type BillingCataloguePriceModel,
	type BillingCatalogueProduct,
	type BillingCatalogueProviderPriceIds,
	type BillingCatalogueTier,
	type BillingProviderEnvironment
} from './schemas.js';
