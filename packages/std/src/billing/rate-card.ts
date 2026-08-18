export const BILLING_RATE_CARD_VERSION = '2026-08-18';

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
 * SGD charged per US dollar of provider spend.
 *
 * AI is not priced from a token table of our own. The provider reports what a call cost and that
 * figure is converted with this rate, so the meter tracks provider pricing directly and moves with
 * it instead of needing a re-audit every time a model's price changes.
 *
 * The rate is a loaded one, not a currency conversion. Spot USD/SGD is well under half of it; the
 * rest is deliberate cover for everything between what a provider charges us and what reaches the
 * bank — the fee on buying provider credit, FX spread on top of spot, card and payout fees on the
 * tenant's invoice, and a margin over all of it. Every one of those moves on somebody else's
 * schedule, so the cover is set generously rather than tracked.
 *
 * It stays one number and not a chain of multipliers. A factored form lived here, evaluated to 1.55,
 * and was called by nothing while the meter that reaches Stripe charged 2.60 — two answers to the
 * same question, the uninvoiced one looking every bit as authoritative. A split that is not itself
 * billed is documentation, and documentation belongs in this comment rather than in arithmetic that
 * can drift away from the price.
 */
export const AI_SGD_PER_PROVIDER_USD = 2.6;

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
