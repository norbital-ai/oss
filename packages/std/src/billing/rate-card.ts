/** The currency every price and invoice is stated in. */
export const BILLING_CURRENCY = 'SGD' as const;

/** The workspace access tiers. */
export const BILLING_ACCESS_TIERS = ['standard', 'builder'] as const;
/** A workspace access tier: `standard` or `builder`. */
export type BillingAccessTier = (typeof BILLING_ACCESS_TIERS)[number];

/**
 * Tenant-visible usage prices. Compute is worker-thread event-loop utilization (ELU) active time,
 * billed in seconds. Memory has no separate usage meter or per-worker hard wall; its infrastructure
 * cost is included in the compute price.
 * Disc and files are GB-months converted to GB-hours over a 730-hour month.
 */
export const COMPUTE_SGD_PER_SECOND = 0.0005;
/** Tenant database storage price, SGD per GB-month. */
export const DISC_SGD_PER_GB_MONTH = 3;
/** Tenant object storage price, SGD per GB-month. */
export const FILES_SGD_PER_GB_MONTH = 0.25;
/** Hours in a billing month, for converting GB-months to GB-hours. */
export const HOURS_PER_BILLING_MONTH = 730;

/** SGD charged per provider USD, including FX, credit/payment fees and margin. */
export const AI_SGD_PER_PROVIDER_USD = 2.6;
