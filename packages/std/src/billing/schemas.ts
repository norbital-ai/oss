import { Schema } from 'effect';
import { BILLING_CURRENCY } from './rate-card.js';

/**
 * The Stripe catalogue surfaces (plans, prices, products) are declared here without a transport
 * dependency, with the shape owned once by these schemas — a host that pushes the catalogue to
 * Stripe decodes from the same source of truth the type is derived from.
 */
export const BillingCatalogueIntervalSchema = Schema.Literals(['month', 'year']);
/** A price's billing interval: `month` or `year`. */
export type BillingCatalogueInterval = Schema.Schema.Type<typeof BillingCatalogueIntervalSchema>;

/** The schema of a price's model: `flat`, `per_seat` or `metered`. */
export const BillingCataloguePriceModelSchema = Schema.Literals(['flat', 'per_seat', 'metered']);
/** A price's model: `flat`, `per_seat` or `metered`. */
export type BillingCataloguePriceModel = Schema.Schema.Type<
	typeof BillingCataloguePriceModelSchema
>;

/** The schema of one price tier: the quantity it runs `upTo` (or `inf`) and its amount. */
export const BillingCatalogueTierSchema = Schema.Struct({
	upTo: Schema.Union([Schema.Number, Schema.Literal('inf')]),
	amount: Schema.String
});
/** One price tier: the quantity it runs `upTo` (or `inf`) and its amount. */
export type BillingCatalogueTier = Schema.Schema.Type<typeof BillingCatalogueTierSchema>;

/** The schema of a billing provider environment: `sandbox` or `production`. */
export const BillingProviderEnvironmentSchema = Schema.Literals(['sandbox', 'production']);
/** A billing provider environment: `sandbox` or `production`. */
export type BillingProviderEnvironment = Schema.Schema.Type<
	typeof BillingProviderEnvironmentSchema
>;

/** The schema of a price's Stripe ids per environment. */
export const BillingCatalogueProviderPriceIdsSchema = Schema.Struct({
	sandbox: Schema.NullishOr(Schema.String),
	production: Schema.NullishOr(Schema.String)
});
/** A price's Stripe price id in the sandbox and in production (`null` where not created). */
export type BillingCatalogueProviderPriceIds = Schema.Schema.Type<
	typeof BillingCatalogueProviderPriceIdsSchema
>;

/** The schema of one catalogue price; hosts decode a catalogue with it before pushing it to Stripe. */
export const BillingCataloguePriceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	model: BillingCataloguePriceModelSchema,
	interval: BillingCatalogueIntervalSchema,
	checkout: Schema.Boolean,
	stripePriceIds: BillingCatalogueProviderPriceIdsSchema,
	amount: Schema.optional(Schema.String),
	unitAmountDecimal: Schema.optional(Schema.String),
	meterId: Schema.optional(Schema.String),
	dimensions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	tiersMode: Schema.optional(Schema.Literals(['graduated', 'volume'])),
	tiers: Schema.optional(Schema.Array(BillingCatalogueTierSchema))
});
/**
 * One catalogue price: its model and interval, whether checkout subscribes it, its Stripe ids, and a flat amount or a metered unit amount and meter.
 */
export type BillingCataloguePrice = Schema.Schema.Type<typeof BillingCataloguePriceSchema>;

/**
 * A plan is the base subscription: a flat fee plus the metered prices in the same product. The
 * paywall checkout subscribes the plan plus every metered price as separate subscription items, so
 * what a plan names is the trial, not seat licensing. There is no seat model: the base fee is
 * stated once per workspace, whatever the headcount.
 */
export const BillingCataloguePlanSchema = Schema.Struct({
	id: Schema.String,
	trialDays: Schema.Number,
	allowPromotionCodes: Schema.Boolean
});
/** A plan: the base subscription's id, trial days and whether promotion codes are allowed. */
export type BillingCataloguePlan = Schema.Schema.Type<typeof BillingCataloguePlanSchema>;

/** The schema of a catalogue product: its prices and plans. */
export const BillingCatalogueProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	prices: Schema.Array(BillingCataloguePriceSchema),
	plans: Schema.Array(BillingCataloguePlanSchema)
});
/** A catalogue product: its name and description, prices and plans. */
export type BillingCatalogueProduct = Schema.Schema.Type<typeof BillingCatalogueProductSchema>;

/** The schema of the whole billing catalogue. */
export const BillingCatalogueSchema = Schema.Struct({
	currency: Schema.Literal(BILLING_CURRENCY),
	products: Schema.Array(BillingCatalogueProductSchema)
});
/** The billing catalogue: its currency and products. */
export type BillingCatalogue = Schema.Schema.Type<typeof BillingCatalogueSchema>;
