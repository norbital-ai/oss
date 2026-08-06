import {
	BILLING_SAFETY_MARGIN_MULTIPLIER,
	BILLING_USD_TO_SGD_RATE,
	EXTERNAL_CLOUD_RATE_CARD_USD,
	LOCAL_CLOUD_RATE_CARD,
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
	providerCostUsdMicros: 'provider_cost_usd_micros'
} as const;

export type BillingCatalogueInterval = 'month' | 'year';
export type BillingCataloguePriceModel = 'flat' | 'per_seat' | 'metered';

export const AI_USAGE_METER_ID = 'norbital_ai_cost_sgd_micros_v1';

const BYTES_PER_MIB = 1024 ** 2;
const SECONDS_PER_HOUR = 3_600;
const MINUTES_PER_NEON_MONTH = 730 * 60;
const MINUTES_PER_R2_MONTH = 30 * 24 * 60;
const MIB_PER_PROVIDER_GB = 1_000_000_000 / BYTES_PER_MIB;

function stripeDecimalCents(sgdPerUnit: number): string {
	return (sgdPerUnit * CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT)
		.toFixed(12)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
}

const CLOUD_METER_UNIT_AMOUNT_CENTS = {
	cpu: stripeDecimalCents(
		(LOCAL_CLOUD_RATE_CARD.serverMonthlyCostSgd *
			LOCAL_CLOUD_RATE_CARD.allocation.cpu *
			BILLING_SAFETY_MARGIN_MULTIPLIER) /
			(LOCAL_CLOUD_RATE_CARD.cpuCores *
				LOCAL_CLOUD_RATE_CARD.hoursPerMonth *
				SECONDS_PER_HOUR *
				1_000)
	),
	ram: stripeDecimalCents(
		(LOCAL_CLOUD_RATE_CARD.serverMonthlyCostSgd *
			LOCAL_CLOUD_RATE_CARD.allocation.ram *
			BILLING_SAFETY_MARGIN_MULTIPLIER) /
			(LOCAL_CLOUD_RATE_CARD.ramGb * 1_024 * LOCAL_CLOUD_RATE_CARD.hoursPerMonth * SECONDS_PER_HOUR)
	),
	disk_local: stripeDecimalCents(
		(LOCAL_CLOUD_RATE_CARD.serverMonthlyCostSgd *
			LOCAL_CLOUD_RATE_CARD.allocation.disk *
			BILLING_SAFETY_MARGIN_MULTIPLIER) /
			(LOCAL_CLOUD_RATE_CARD.diskGb * 1_024 * LOCAL_CLOUD_RATE_CARD.hoursPerMonth * 60)
	),
	disk_neon: stripeDecimalCents(
		(EXTERNAL_CLOUD_RATE_CARD_USD.neonStoragePerGbMonth *
			BILLING_USD_TO_SGD_RATE *
			BILLING_SAFETY_MARGIN_MULTIPLIER) /
			(MIB_PER_PROVIDER_GB * MINUTES_PER_NEON_MONTH)
	),
	disk_r2: stripeDecimalCents(
		(EXTERNAL_CLOUD_RATE_CARD_USD.r2StoragePerGbMonth *
			BILLING_USD_TO_SGD_RATE *
			BILLING_SAFETY_MARGIN_MULTIPLIER) /
			(MIB_PER_PROVIDER_GB * MINUTES_PER_R2_MONTH)
	)
} as const;

export const CLOUD_USAGE_METER_IDS = {
	cpu: 'norbital_cpu_millicore_seconds_v1',
	ram: 'norbital_ram_mib_seconds_v1',
	disk_local: 'norbital_disk_local_mib_minutes_v1',
	disk_neon: 'norbital_disk_neon_mib_minutes_v1',
	disk_r2: 'norbital_disk_r2_mib_minutes_v1'
} as const;

export const CLOUD_USAGE_UNITS = {
	cpu: 'millicore-second',
	ram: 'MiB-second',
	disk_local: 'MiB-minute',
	disk_neon: 'MiB-minute',
	disk_r2: 'MiB-minute'
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
			'One subscription containing Standard and Pro seats plus separately metered CPU, RAM, disk, and AI usage.',
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
				id: 'cpu-millicore-second-monthly',
				name: 'CPU usage',
				description:
					'SGD 0.0143826 per vCPU-hour; measured as 1,000 millicore-seconds per vCPU-second.',
				model: 'metered',
				meterId: CLOUD_USAGE_METER_IDS.cpu,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7G6LvWjJB44nUftzJt81E',
					production: 'price_1Ty7GBLlQVSVzCBMozTR0vrx'
				},
				unitAmountDecimal: CLOUD_METER_UNIT_AMOUNT_CENTS.cpu
			},
			{
				id: 'ram-mib-second-monthly',
				name: 'RAM usage',
				description: 'SGD 0.00235965 per GiB-hour; measured in MiB-seconds.',
				model: 'metered',
				meterId: CLOUD_USAGE_METER_IDS.ram,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7G7LvWjJB44nU77OkZvG7',
					production: 'price_1Ty7GCLlQVSVzCBMqYYG2NKF'
				},
				unitAmountDecimal: CLOUD_METER_UNIT_AMOUNT_CENTS.ram
			},
			{
				id: 'disk-local-mib-minute-monthly',
				name: 'Disk usage · local NVMe',
				description:
					'SGD 0.0440407 per GiB-month for tenant workspace, file, and checkpoint storage.',
				model: 'metered',
				meterId: CLOUD_USAGE_METER_IDS.disk_local,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7N6LvWjJB44nU9hwTFumB',
					production: 'price_1Ty7N8LlQVSVzCBMBTXnfd3y'
				},
				unitAmountDecimal: CLOUD_METER_UNIT_AMOUNT_CENTS.disk_local
			},
			{
				id: 'disk-neon-mib-minute-monthly',
				name: 'Disk usage · Neon database',
				description: 'SGD 0.5145 per provider GB-month for tenant database storage.',
				model: 'metered',
				meterId: CLOUD_USAGE_METER_IDS.disk_neon,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7N7LvWjJB44nUpcYREKZR',
					production: 'price_1Ty7N8LlQVSVzCBMJzWiEC1v'
				},
				unitAmountDecimal: CLOUD_METER_UNIT_AMOUNT_CENTS.disk_neon
			},
			{
				id: 'disk-r2-mib-minute-monthly',
				name: 'Disk usage · R2 object storage',
				description: 'SGD 0.02205 per provider GB-month for tenant object storage.',
				model: 'metered',
				meterId: CLOUD_USAGE_METER_IDS.disk_r2,
				interval: 'month',
				checkout: true,
				stripePriceIds: {
					sandbox: 'price_1Ty7N7LvWjJB44nUaUNRrtRO',
					production: 'price_1Ty7N9LlQVSVzCBMa1M93Hwd'
				},
				unitAmountDecimal: CLOUD_METER_UNIT_AMOUNT_CENTS.disk_r2
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
	EXTERNAL_CLOUD_RATE_CARD_USD,
	LOCAL_CLOUD_RATE_CARD,
	OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER,
	type BillingAccessTier
} from './rate-card.js';
export {
	BILLING_ALLOCATION_METHODS,
	BILLING_MAX_GAUGE_SAMPLE_INTERVAL_SECONDS,
	BILLING_MEASUREMENT_STATUSES,
	BILLING_RESOURCE_TYPES,
	BILLING_RESOURCE_UNITS,
	BILLING_SOURCE_CATALOGUE,
	BILLING_SOURCE_IDS,
	integrateBillingObservation,
	isUsageBillableSubscriptionStatus,
	type BillingAllocationMethod,
	type BillingIntegrationInput,
	type BillingIntegrationResult,
	type BillingMeasurementStatus,
	type BillingResourceType,
	type BillingSourceDefinition,
	type BillingSourceId
} from './metering.js';
