export const BILLING_RATE_CARD_VERSION = '2026-08-18';
export const BILLING_SAFETY_MARGIN_MULTIPLIER = 1.05;
export const BILLING_USD_TO_SGD_RATE = 1.4;
export const OPENROUTER_CREDIT_PURCHASE_FEE_MULTIPLIER = 1.055;

export const BILLING_ACCESS_TIERS = ['standard', 'builder'] as const;
export type BillingAccessTier = (typeof BILLING_ACCESS_TIERS)[number];

/**
 * Tenant-visible usage prices. Compute is one isolate-second: the isolate already
 * hard-walls CPU time and RAM together, so memory is not a separate meter.
 * Disc and files are GB-months converted to GB-hours over a 730-hour month.
 */
export const COMPUTE_SGD_PER_SECOND = 0.0005;
export const DISC_SGD_PER_GB_MONTH = 3;
export const FILES_SGD_PER_GB_MONTH = 0.25;
export const HOURS_PER_BILLING_MONTH = 730;

/**
 * Local bare-metal cost allocation, kept for capacity planning. It is not a
 * customer-facing meter split: RAM is bundled into compute seconds.
 */
export const LOCAL_CLOUD_RATE_CARD = {
	serverMonthlyCostSgd: 149.99,
	hoursPerMonth: HOURS_PER_BILLING_MONTH,
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
