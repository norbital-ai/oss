export const BILLING_RATE_CARD_VERSION = '2026-07-28';
export const BILLING_SAFETY_MARGIN_MULTIPLIER = 1.05;
export const BILLING_USD_TO_SGD_RATE = 1.4;
export const OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER = 1.055;

export const BILLING_ACCESS_TIERS = ['standard', 'builder'] as const;
export type BillingAccessTier = (typeof BILLING_ACCESS_TIERS)[number];

/**
 * Local bare-metal cost allocation. The three shares add to 100%, so CPU,
 * memory, and disk are never charged as three copies of the same server bill.
 */
export const LOCAL_CLOUD_RATE_CARD = {
	serverMonthlyCostSgd: 149.99,
	hoursPerMonth: 730,
	cpuCores: 6,
	ramGb: 32,
	diskGb: 894,
	allocation: {
		cpu: 0.4,
		ram: 0.35,
		disk: 0.25
	}
} as const;

export const EXTERNAL_CLOUD_RATE_CARD_USD = {
	neonComputePerCuHour: 0.106,
	neonStoragePerGbMonth: 0.35,
	neonRestorePerGbMonth: 0.2,
	neonExtraBranchPerHour: 0.002,
	r2StoragePerGbMonth: 0.015,
	r2ClassAPerMillion: 4.5,
	r2ClassBPerMillion: 0.36
} as const;
