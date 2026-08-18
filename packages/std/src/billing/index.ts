import {
	BILLING_SAFETY_MARGIN_MULTIPLIER,
	BILLING_USD_TO_SGD_RATE,
	COMPUTE_SGD_PER_SECOND,
	DISC_SGD_PER_GB_MONTH,
	FILES_SGD_PER_GB_MONTH,
	HOURS_PER_BILLING_MONTH,
	OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER,
	type BillingAccessTier
} from './rate-card.js';

export const BILLING_CURRENCY = 'SGD' as const;
export const DEFAULT_BILLING_TRIAL_DAYS = 30;
export const CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT = 100;
export const PLATFORM_PRODUCT_ID = 'platform';

export const AI_USAGE_DIMENSION_KEYS = {
	model: 'model',
	inputTokens: 'input_tokens',
	cachedInputTokens: 'cached_input_tokens',
	outputTokens: 'output_tokens',
	reasoningTokens: 'reasoning_tokens',
	providerCostUsdMicros: 'provider_cost_usd_micros'
} as const;

export type BillingCatalogueInterval = 'month' | 'year';
export type BillingCataloguePriceModel = 'flat' | 'per_seat' | 'metered';

export const AI_USAGE_METER_ID = 'norbital_ai_cost_sgd_micros_v1';

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

export const USAGE_METER_IDS = {
	compute: 'norbital_compute_seconds_v1',
	disc: 'norbital_disc_gb_hours_v1',
	files: 'norbital_files_gb_hours_v1',
	ai: AI_USAGE_METER_ID
} as const;

export const USAGE_METER_UNITS = {
	compute: 'millisecond',
	disc: 'micro-GB-hour',
	files: 'micro-GB-hour',
	ai: 'micro-SGD'
} as const;

export function calculateAIProviderCostSgdMicros(providerCostUsd: number): number {
	if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
		throw new Error('AI provider cost must be a finite non-negative USD amount');
	}
	return Math.round(
		providerCostUsd *
			OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER *
			BILLING_USD_TO_SGD_RATE *
			BILLING_SAFETY_MARGIN_MULTIPLIER *
			1_000_000
	);
}

export type BillingCatalogueTier = {
	upTo: number | 'inf';
	amount: string;
};

export type BillingProviderEnvironment = 'sandbox' | 'production';

export type BillingCatalogueProviderPriceIds = {
	sandbox: string | null;
	production: string | null;
};

export type BillingCataloguePrice = {
	id: string;
	name: string;
	description: string;
	model: BillingCataloguePriceModel;
	interval: BillingCatalogueInterval;
	checkout: boolean;
	stripePriceIds: BillingCatalogueProviderPriceIds;
	amount?: string;
	unitAmountDecimal?: string;
	meterId?: string;
	dimensions?: Readonly<Record<string, string>>;
	tiersMode?: 'graduated' | 'volume';
	tiers?: readonly BillingCatalogueTier[];
};

export type BillingCataloguePlan = {
	id: string;
	trialDays: number;
	allowPromotionCodes: boolean;
	checkoutSeatPriceId: BillingCataloguePrice['id'];
	seatPriceIds: Readonly<Record<BillingAccessTier, BillingCataloguePrice['id']>>;
};

export type BillingCatalogueProduct = {
	id: string;
	name: string;
	description: string;
	prices: readonly BillingCataloguePrice[];
	plans: readonly BillingCataloguePlan[];
};

export type BillingCatalogue = {
	currency: typeof BILLING_CURRENCY;
	products: readonly BillingCatalogueProduct[];
};

export function formatBillingAmountFromMinorUnits(
	amountMinorUnits: string | number,
	options?: {
		minimumFractionDigits?: number;
		maximumFractionDigits?: number;
	}
): string {
	const numericAmount =
		typeof amountMinorUnits === 'number' ? amountMinorUnits : Number(amountMinorUnits);

	return `${BILLING_CURRENCY} ${new Intl.NumberFormat('en-SG', {
		minimumFractionDigits: options?.minimumFractionDigits ?? 0,
		maximumFractionDigits: options?.maximumFractionDigits ?? 2
	}).format(numericAmount / CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT)}`;
}

export const AI_METERED_PRICES = [
	{
		id: 'ai-provider-cost-micros-monthly',
		name: 'AI usage',
		description:
			'OpenRouter request credits converted from USD to micro-SGD after the 5.5% credit-purchase fee, published billing FX rate, and 5% safety margin. Token counts and model remain attached to every event for audit.',
		model: 'metered',
		meterId: AI_USAGE_METER_ID,
		stripePriceIds: {
			sandbox: 'price_1Ty8XqLvWjJB44nUyTvOAuYp',
			production: 'price_1TyCvvLlQVSVzCBMS9rUyU0V'
		},
		unitAmountDecimal: '0.0001',
		interval: 'month',
		checkout: true
	}
] as const satisfies readonly BillingCataloguePrice[];

export const LATEST_CATALOGUE_PRODUCTS = [
	{
		id: PLATFORM_PRODUCT_ID,
		name: 'Norbital Platform',
		description:
			'One subscription containing Standard and Pro seats plus separately metered compute, disc, files, and AI usage.',
		prices: [
			{
				id: 'platform-standard-seat-monthly',
				name: 'Standard seat (Monthly)',
				description: 'License fee charged monthly at SGD 10.00 per standard seat.',
				model: 'per_seat',
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7G6LvWjJB44nUdFZCNgSw',
					production: 'price_1Ty7GBLlQVSVzCBM3qAEqbi7'
				},
				amount: '1000'
			},
			{
				id: 'platform-builder-seat-monthly',
				name: 'Pro seat (Monthly)',
				description:
					'License fee charged monthly at SGD 50.00 per Pro seat (agent and sandbox access).',
				model: 'per_seat',
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					// Sandbox + production: Pro · SGD 50 (2026-08-06). Old SGD 45 prices archived.
					sandbox: 'price_1U1LEvLvWjJB44nUITBB7tR4',
					production: 'price_1U1LZHLlQVSVzCBMq3ValfFX'
				},
				amount: '5000'
			},
			{
				id: 'compute-second-monthly',
				name: 'Compute usage',
				description:
					'SGD 0.0005 per isolate compute second. RAM is included because the isolate hard-walls memory with that second. Stripe records milliseconds.',
				model: 'metered',
				meterId: USAGE_METER_IDS.compute,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1U5gO4LvWjJB44nUCUzkwD61',
					production: 'price_1U5gPrLlQVSVzCBMefEfyUnM'
				},
				unitAmountDecimal: USAGE_METER_UNIT_AMOUNT_CENTS.compute
			},
			{
				id: 'disc-gb-hour-monthly',
				name: 'Disc usage',
				description: 'SGD 3.00 per GB-month for tenant database storage, measured in GB-hours.',
				model: 'metered',
				meterId: USAGE_METER_IDS.disc,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1U5gOQLvWjJB44nUkHqcqjGn',
					production: 'price_1U5gPrLlQVSVzCBM3ctzic6b'
				},
				unitAmountDecimal: USAGE_METER_UNIT_AMOUNT_CENTS.disc
			},
			{
				id: 'files-gb-hour-monthly',
				name: 'Files usage',
				description: 'SGD 0.25 per GB-month for tenant object storage, measured in GB-hours.',
				model: 'metered',
				meterId: USAGE_METER_IDS.files,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1U5gORLvWjJB44nUzycz1ITJ',
					production: 'price_1U5gPsLlQVSVzCBMHKfK5Ker'
				},
				unitAmountDecimal: USAGE_METER_UNIT_AMOUNT_CENTS.files
			},
			...AI_METERED_PRICES
		],
		plans: [
			{
				id: PLATFORM_PRODUCT_ID,
				trialDays: DEFAULT_BILLING_TRIAL_DAYS,
				allowPromotionCodes: true,
				checkoutSeatPriceId: 'platform-builder-seat-monthly',
				seatPriceIds: {
					standard: 'platform-standard-seat-monthly',
					builder: 'platform-builder-seat-monthly'
				}
			}
		]
	}
] as const satisfies readonly BillingCatalogueProduct[];

export const LATEST_CATALOGUE_PRICES = LATEST_CATALOGUE_PRODUCTS[0]
	.prices as readonly BillingCataloguePrice[];

export function calculateCatalogueMeterCostSgdMicros(meterId: string, quantity: number): number {
	if (!Number.isSafeInteger(quantity) || quantity < 0) {
		throw new Error('Meter quantity must be a non-negative safe integer');
	}
	const price = LATEST_CATALOGUE_PRICES.find((candidate) => candidate.meterId === meterId);
	if (!price?.unitAmountDecimal) {
		throw new Error(`Catalogue meter price is missing for ${meterId}`);
	}
	return Math.round(quantity * Number(price.unitAmountDecimal) * 10_000);
}

export const LATEST_CATALOGUE_PLANS = LATEST_CATALOGUE_PRODUCTS[0]
	.plans as readonly BillingCataloguePlan[];

export const LATEST_CATALOGUE = {
	currency: BILLING_CURRENCY,
	products: LATEST_CATALOGUE_PRODUCTS
} as const satisfies BillingCatalogue;

export {
	BILLING_ACCESS_TIERS,
	BILLING_RATE_CARD_VERSION,
	BILLING_SAFETY_MARGIN_MULTIPLIER,
	BILLING_USD_TO_SGD_RATE,
	COMPUTE_SGD_PER_SECOND,
	DISC_SGD_PER_GB_MONTH,
	EXTERNAL_CLOUD_RATE_CARD_USD,
	FILES_SGD_PER_GB_MONTH,
	HOURS_PER_BILLING_MONTH,
	LOCAL_CLOUD_RATE_CARD,
	OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER,
	type BillingAccessTier
} from './rate-card.js';
export {
	BILLING_SOURCE_CATALOGUE,
	BILLING_SOURCE_IDS,
	BILLING_SOURCE_UNITS,
	type BillingSourceDefinition,
	type BillingSourceId
} from './metering.js';
