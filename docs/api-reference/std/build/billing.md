[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/billing

# std/build/billing

## Type Aliases

<a id="billingcatalogue"></a>

### BillingCatalogue

```ts
type BillingCatalogue = Schema.Schema.Type<typeof BillingCatalogueSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:150

***

<a id="billingcatalogueinterval"></a>

### BillingCatalogueInterval

```ts
type BillingCatalogueInterval = Schema.Schema.Type<typeof BillingCatalogueIntervalSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:12

***

<a id="billingcatalogueplan"></a>

### BillingCataloguePlan

```ts
type BillingCataloguePlan = Schema.Schema.Type<typeof BillingCataloguePlanSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:83

***

<a id="billingcatalogueprice"></a>

### BillingCataloguePrice

```ts
type BillingCataloguePrice = Schema.Schema.Type<typeof BillingCataloguePriceSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:71

***

<a id="billingcataloguepricemodel"></a>

### BillingCataloguePriceModel

```ts
type BillingCataloguePriceModel = Schema.Schema.Type<typeof BillingCataloguePriceModelSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:14

***

<a id="billingcatalogueproduct"></a>

### BillingCatalogueProduct

```ts
type BillingCatalogueProduct = Schema.Schema.Type<typeof BillingCatalogueProductSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:115

***

<a id="billingcatalogueproviderpriceids"></a>

### BillingCatalogueProviderPriceIds

```ts
type BillingCatalogueProviderPriceIds = Schema.Schema.Type<typeof BillingCatalogueProviderPriceIdsSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:49

***

<a id="billingcataloguetier"></a>

### BillingCatalogueTier

```ts
type BillingCatalogueTier = Schema.Schema.Type<typeof BillingCatalogueTierSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:42

***

<a id="billingproviderenvironment"></a>

### BillingProviderEnvironment

```ts
type BillingProviderEnvironment = Schema.Schema.Type<typeof BillingProviderEnvironmentSchema>;
```

Defined in: packages/std/build/billing/index.d.ts:44

## Variables

<a id="ai_metered_prices"></a>

### AI\_METERED\_PRICES

```ts
const AI_METERED_PRICES: readonly [{
  checkout: true;
  description: "Provider-reported request cost converted from USD to micro-SGD at the published billing rate, which loads provider credit fees, FX, payment processing and margin onto the conversion. Token counts and model remain attached to every event for audit.";
  id: "ai-provider-cost-micros-monthly";
  interval: "month";
  meterId: "bolt_ai_cost_sgd_micros_v1";
  model: "metered";
  name: "AI usage";
  stripePriceIds: {
     production: "price_1TyCvvLlQVSVzCBMS9rUyU0V";
     sandbox: "price_1Ty8XqLvWjJB44nUyTvOAuYp";
  };
  unitAmountDecimal: "0.0001";
}];
```

Defined in: packages/std/build/billing/index.d.ts:155

***

<a id="ai_usage_meter_id"></a>

### AI\_USAGE\_METER\_ID

```ts
const AI_USAGE_METER_ID: "bolt_ai_cost_sgd_micros_v1" = "bolt_ai_cost_sgd_micros_v1";
```

Defined in: packages/std/build/billing/index.d.ts:15

***

<a id="billing_currency"></a>

### BILLING\_CURRENCY

```ts
const BILLING_CURRENCY: "SGD";
```

Defined in: packages/std/build/billing/index.d.ts:2

***

<a id="billingcatalogueintervalschema"></a>

### BillingCatalogueIntervalSchema

```ts
const BillingCatalogueIntervalSchema: Schema.Literals<readonly ["month", "year"]>;
```

Defined in: packages/std/build/billing/index.d.ts:11

The Stripe catalogue surfaces (plans, prices, products) are declared here without a transport
dependency, with the shape owned once by these schemas — a host that pushes the catalogue to
Stripe decodes from the same source of truth the type is derived from.

***

<a id="billingcatalogueplanschema"></a>

### BillingCataloguePlanSchema

```ts
const BillingCataloguePlanSchema: Schema.Struct<{
  allowPromotionCodes: Schema.Boolean;
  id: Schema.String;
  trialDays: Schema.Number;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:78

A plan is the base subscription: a flat fee plus the metered prices in the same product. The
paywall checkout subscribes the plan plus every metered price as separate subscription items, so
what a plan names is the trial, not seat licensing. There is no seat model: the base fee is
stated once per workspace, whatever the headcount.

***

<a id="billingcataloguepricemodelschema"></a>

### BillingCataloguePriceModelSchema

```ts
const BillingCataloguePriceModelSchema: Schema.Literals<readonly ["flat", "per_seat", "metered"]>;
```

Defined in: packages/std/build/billing/index.d.ts:13

***

<a id="billingcataloguepriceschema"></a>

### BillingCataloguePriceSchema

```ts
const BillingCataloguePriceSchema: Schema.Struct<{
  amount: Schema.optional<Schema.String>;
  checkout: Schema.Boolean;
  description: Schema.String;
  dimensions: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
  id: Schema.String;
  interval: Schema.Literals<readonly ["month", "year"]>;
  meterId: Schema.optional<Schema.String>;
  model: Schema.Literals<readonly ["flat", "per_seat", "metered"]>;
  name: Schema.String;
  stripePriceIds: Schema.Struct<{
     production: Schema.NullishOr<Schema.String>;
     sandbox: Schema.NullishOr<Schema.String>;
  }>;
  tiers: Schema.optional<Schema.$Array<Schema.Struct<{
     amount: Schema.String;
     upTo: Schema.Union<readonly [Schema.Number, Schema.Literal<"inf">]>;
  }>>>;
  tiersMode: Schema.optional<Schema.Literals<readonly ["graduated", "volume"]>>;
  unitAmountDecimal: Schema.optional<Schema.String>;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:50

***

<a id="billingcatalogueproductschema"></a>

### BillingCatalogueProductSchema

```ts
const BillingCatalogueProductSchema: Schema.Struct<{
  description: Schema.String;
  id: Schema.String;
  name: Schema.String;
  plans: Schema.$Array<Schema.Struct<{
     allowPromotionCodes: Schema.Boolean;
     id: Schema.String;
     trialDays: Schema.Number;
  }>>;
  prices: Schema.$Array<Schema.Struct<{
     amount: Schema.optional<Schema.String>;
     checkout: Schema.Boolean;
     description: Schema.String;
     dimensions: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
     id: Schema.String;
     interval: Schema.Literals<readonly ["month", "year"]>;
     meterId: Schema.optional<Schema.String>;
     model: Schema.Literals<readonly ["flat", "per_seat", "metered"]>;
     name: Schema.String;
     stripePriceIds: Schema.Struct<{
        production: Schema.NullishOr<Schema.String>;
        sandbox: Schema.NullishOr<Schema.String>;
     }>;
     tiers: Schema.optional<Schema.$Array<Schema.Struct<{
        amount: Schema.String;
        upTo: Schema.Union<readonly ...>;
     }>>>;
     tiersMode: Schema.optional<Schema.Literals<readonly ["graduated", "volume"]>>;
     unitAmountDecimal: Schema.optional<Schema.String>;
  }>>;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:84

***

<a id="billingcatalogueproviderpriceidsschema"></a>

### BillingCatalogueProviderPriceIdsSchema

```ts
const BillingCatalogueProviderPriceIdsSchema: Schema.Struct<{
  production: Schema.NullishOr<Schema.String>;
  sandbox: Schema.NullishOr<Schema.String>;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:45

***

<a id="billingcatalogueschema"></a>

### BillingCatalogueSchema

```ts
const BillingCatalogueSchema: Schema.Struct<{
  currency: Schema.Literal<"SGD">;
  products: Schema.$Array<Schema.Struct<{
     description: Schema.String;
     id: Schema.String;
     name: Schema.String;
     plans: Schema.$Array<Schema.Struct<{
        allowPromotionCodes: Schema.Boolean;
        id: Schema.String;
        trialDays: Schema.Number;
     }>>;
     prices: Schema.$Array<Schema.Struct<{
        amount: Schema.optional<Schema.String>;
        checkout: Schema.Boolean;
        description: Schema.String;
        dimensions: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        id: Schema.String;
        interval: Schema.Literals<readonly [..., ...]>;
        meterId: Schema.optional<Schema.String>;
        model: Schema.Literals<readonly [..., ..., ...]>;
        name: Schema.String;
        stripePriceIds: Schema.Struct<{
           production: Schema.NullishOr<...>;
           sandbox: Schema.NullishOr<...>;
        }>;
        tiers: Schema.optional<Schema.$Array<Schema.Struct<...>>>;
        tiersMode: Schema.optional<Schema.Literals<readonly ...>>;
        unitAmountDecimal: Schema.optional<Schema.String>;
     }>>;
  }>>;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:116

***

<a id="billingcataloguetierschema"></a>

### BillingCatalogueTierSchema

```ts
const BillingCatalogueTierSchema: Schema.Struct<{
  amount: Schema.String;
  upTo: Schema.Union<readonly [Schema.Number, Schema.Literal<"inf">]>;
}>;
```

Defined in: packages/std/build/billing/index.d.ts:38

***

<a id="billingproviderenvironmentschema"></a>

### BillingProviderEnvironmentSchema

```ts
const BillingProviderEnvironmentSchema: Schema.Literals<readonly ["sandbox", "production"]>;
```

Defined in: packages/std/build/billing/index.d.ts:43

***

<a id="currency_minor_units_per_major_unit"></a>

### CURRENCY\_MINOR\_UNITS\_PER\_MAJOR\_UNIT

```ts
const CURRENCY_MINOR_UNITS_PER_MAJOR_UNIT: 100 = 100;
```

Defined in: packages/std/build/billing/index.d.ts:4

***

<a id="default_billing_trial_days"></a>

### DEFAULT\_BILLING\_TRIAL\_DAYS

```ts
const DEFAULT_BILLING_TRIAL_DAYS: 30 = 30;
```

Defined in: packages/std/build/billing/index.d.ts:3

***

<a id="latest_catalogue"></a>

### LATEST\_CATALOGUE

```ts
const LATEST_CATALOGUE: object;
```

Defined in: packages/std/build/billing/index.d.ts:235

#### Type Declaration

<a id="currency"></a>

##### currency

```ts
readonly currency: "SGD";
```

<a id="products"></a>

##### products

```ts
readonly products: readonly [{
  description: "A flat base fee per workspace, plus separately metered compute, disc, files, and AI usage.";
  id: "platform";
  name: "Norbital Platform";
  plans: readonly [{
     allowPromotionCodes: true;
     id: "platform";
     trialDays: 30;
  }];
  prices: readonly [{
     checkout: true;
     description: "SGD 0.0005 per isolate compute second. RAM is included because the isolate hard-walls memory with that second. Stripe records milliseconds.";
     id: "compute-second-monthly";
     interval: "month";
     meterId: "bolt_compute_seconds_v1";
     model: "metered";
     name: "Compute usage";
     stripePriceIds: {
        production: "price_1U5gPrLlQVSVzCBMefEfyUnM";
        sandbox: "price_1U5gO4LvWjJB44nUCUzkwD61";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "SGD 3.00 per GB-month for tenant database storage, measured in GB-hours.";
     id: "disc-gb-hour-monthly";
     interval: "month";
     meterId: "bolt_disc_gb_hours_v1";
     model: "metered";
     name: "Disc usage";
     stripePriceIds: {
        production: "price_1U5gPrLlQVSVzCBM3ctzic6b";
        sandbox: "price_1U5gOQLvWjJB44nUkHqcqjGn";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "SGD 0.25 per GB-month for tenant object storage, measured in GB-hours.";
     id: "files-gb-hour-monthly";
     interval: "month";
     meterId: "bolt_files_gb_hours_v1";
     model: "metered";
     name: "Files usage";
     stripePriceIds: {
        production: "price_1U5gPsLlQVSVzCBMHKfK5Ker";
        sandbox: "price_1U5gORLvWjJB44nUzycz1ITJ";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "Provider-reported request cost converted from USD to micro-SGD at the published billing rate, which loads provider credit fees, FX, payment processing and margin onto the conversion. Token counts and model remain attached to every event for audit.";
     id: "ai-provider-cost-micros-monthly";
     interval: "month";
     meterId: "bolt_ai_cost_sgd_micros_v1";
     model: "metered";
     name: "AI usage";
     stripePriceIds: {
        production: "price_1TyCvvLlQVSVzCBMS9rUyU0V";
        sandbox: "price_1Ty8XqLvWjJB44nUyTvOAuYp";
     };
     unitAmountDecimal: "0.0001";
  }];
}];
```

***

<a id="latest_catalogue_plans"></a>

### LATEST\_CATALOGUE\_PLANS

```ts
const LATEST_CATALOGUE_PLANS: readonly BillingCataloguePlan[];
```

Defined in: packages/std/build/billing/index.d.ts:234

***

<a id="latest_catalogue_prices"></a>

### LATEST\_CATALOGUE\_PRICES

```ts
const LATEST_CATALOGUE_PRICES: readonly BillingCataloguePrice[];
```

Defined in: packages/std/build/billing/index.d.ts:232

***

<a id="latest_catalogue_products"></a>

### LATEST\_CATALOGUE\_PRODUCTS

```ts
const LATEST_CATALOGUE_PRODUCTS: readonly [{
  description: "A flat base fee per workspace, plus separately metered compute, disc, files, and AI usage.";
  id: "platform";
  name: "Norbital Platform";
  plans: readonly [{
     allowPromotionCodes: true;
     id: "platform";
     trialDays: 30;
  }];
  prices: readonly [{
     checkout: true;
     description: "SGD 0.0005 per isolate compute second. RAM is included because the isolate hard-walls memory with that second. Stripe records milliseconds.";
     id: "compute-second-monthly";
     interval: "month";
     meterId: "bolt_compute_seconds_v1";
     model: "metered";
     name: "Compute usage";
     stripePriceIds: {
        production: "price_1U5gPrLlQVSVzCBMefEfyUnM";
        sandbox: "price_1U5gO4LvWjJB44nUCUzkwD61";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "SGD 3.00 per GB-month for tenant database storage, measured in GB-hours.";
     id: "disc-gb-hour-monthly";
     interval: "month";
     meterId: "bolt_disc_gb_hours_v1";
     model: "metered";
     name: "Disc usage";
     stripePriceIds: {
        production: "price_1U5gPrLlQVSVzCBM3ctzic6b";
        sandbox: "price_1U5gOQLvWjJB44nUkHqcqjGn";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "SGD 0.25 per GB-month for tenant object storage, measured in GB-hours.";
     id: "files-gb-hour-monthly";
     interval: "month";
     meterId: "bolt_files_gb_hours_v1";
     model: "metered";
     name: "Files usage";
     stripePriceIds: {
        production: "price_1U5gPsLlQVSVzCBMHKfK5Ker";
        sandbox: "price_1U5gORLvWjJB44nUzycz1ITJ";
     };
     unitAmountDecimal: string;
   }, {
     checkout: true;
     description: "Provider-reported request cost converted from USD to micro-SGD at the published billing rate, which loads provider credit fees, FX, payment processing and margin onto the conversion. Token counts and model remain attached to every event for audit.";
     id: "ai-provider-cost-micros-monthly";
     interval: "month";
     meterId: "bolt_ai_cost_sgd_micros_v1";
     model: "metered";
     name: "AI usage";
     stripePriceIds: {
        production: "price_1TyCvvLlQVSVzCBMS9rUyU0V";
        sandbox: "price_1Ty8XqLvWjJB44nUyTvOAuYp";
     };
     unitAmountDecimal: "0.0001";
  }];
}];
```

Defined in: packages/std/build/billing/index.d.ts:169

***

<a id="platform_product_id"></a>

### PLATFORM\_PRODUCT\_ID

```ts
const PLATFORM_PRODUCT_ID: "platform" = "platform";
```

Defined in: packages/std/build/billing/index.d.ts:5

***

<a id="usage_meter_ids"></a>

### USAGE\_METER\_IDS

```ts
const USAGE_METER_IDS: object;
```

Defined in: packages/std/build/billing/index.d.ts:16

#### Type Declaration

<a id="ai"></a>

##### ai

```ts
readonly ai: "bolt_ai_cost_sgd_micros_v1";
```

<a id="compute"></a>

##### compute

```ts
readonly compute: "bolt_compute_seconds_v1";
```

<a id="disc"></a>

##### disc

```ts
readonly disc: "bolt_disc_gb_hours_v1";
```

<a id="files"></a>

##### files

```ts
readonly files: "bolt_files_gb_hours_v1";
```

***

<a id="usage_meter_units"></a>

### USAGE\_METER\_UNITS

```ts
const USAGE_METER_UNITS: object;
```

Defined in: packages/std/build/billing/index.d.ts:22

#### Type Declaration

<a id="ai-1"></a>

##### ai

```ts
readonly ai: "micro-SGD";
```

<a id="compute-1"></a>

##### compute

```ts
readonly compute: "millisecond";
```

<a id="disc-1"></a>

##### disc

```ts
readonly disc: "micro-GB-hour";
```

<a id="files-1"></a>

##### files

```ts
readonly files: "micro-GB-hour";
```

## Functions

<a id="aiprovidercostsgdmicros"></a>

### aiProviderCostSgdMicros()

```ts
function aiProviderCostSgdMicros(providerCostUsd): number;
```

Defined in: packages/std/build/billing/index.d.ts:37

What a tenant owes for one turn, in micro-SGD, given what the provider charged for it in USD.

The single conversion for AI spend: the ledger prices an observation with it, the Stripe meter
reports the quantity it returns, and the agent panel shows a conversation's total through it.
There used to be three — a factored one here that nothing called, and the same literal written out
twice more where the meter actually ran — so the published rate and the billed rate could differ
with nothing in the code to say which one was the price.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `providerCostUsd` | `number` |

#### Returns

`number`

***

<a id="calculatecataloguemetercostsgdmicros"></a>

### calculateCatalogueMeterCostSgdMicros()

```ts
function calculateCatalogueMeterCostSgdMicros(meterId, quantity): number;
```

Defined in: packages/std/build/billing/index.d.ts:233

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meterId` | `string` |
| `quantity` | `number` |

#### Returns

`number`

***

<a id="formatbillingamountfromminorunits"></a>

### formatBillingAmountFromMinorUnits()

```ts
function formatBillingAmountFromMinorUnits(amountMinorUnits, options?): string;
```

Defined in: packages/std/build/billing/index.d.ts:151

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `amountMinorUnits` | `string` \| `number` |
| `options?` | \{ `maximumFractionDigits?`: `number`; `minimumFractionDigits?`: `number`; \} |
| `options.maximumFractionDigits?` | `number` |
| `options.minimumFractionDigits?` | `number` |

#### Returns

`string`

## References

<a id="ai_sgd_per_provider_usd"></a>

### AI\_SGD\_PER\_PROVIDER\_USD

Re-exports [AI_SGD_PER_PROVIDER_USD](/docs/api-reference/std/build/billing/rate-card.md#ai_sgd_per_provider_usd)

***

<a id="billing_access_tiers"></a>

### BILLING\_ACCESS\_TIERS

Re-exports [BILLING_ACCESS_TIERS](/docs/api-reference/std/build/billing/rate-card.md#billing_access_tiers)

***

<a id="billing_rate_card_version"></a>

### BILLING\_RATE\_CARD\_VERSION

Re-exports [BILLING_RATE_CARD_VERSION](/docs/api-reference/std/build/billing/rate-card.md#billing_rate_card_version)

***

<a id="billingaccesstier"></a>

### BillingAccessTier

Re-exports [BillingAccessTier](/docs/api-reference/std/build/billing/rate-card.md#billingaccesstier)

***

<a id="compute_sgd_per_second"></a>

### COMPUTE\_SGD\_PER\_SECOND

Re-exports [COMPUTE_SGD_PER_SECOND](/docs/api-reference/std/build/billing/rate-card.md#compute_sgd_per_second)

***

<a id="disc_sgd_per_gb_month"></a>

### DISC\_SGD\_PER\_GB\_MONTH

Re-exports [DISC_SGD_PER_GB_MONTH](/docs/api-reference/std/build/billing/rate-card.md#disc_sgd_per_gb_month)

***

<a id="external_cloud_rate_card_usd"></a>

### EXTERNAL\_CLOUD\_RATE\_CARD\_USD

Re-exports [EXTERNAL_CLOUD_RATE_CARD_USD](/docs/api-reference/std/build/billing/rate-card.md#external_cloud_rate_card_usd)

***

<a id="files_sgd_per_gb_month"></a>

### FILES\_SGD\_PER\_GB\_MONTH

Re-exports [FILES_SGD_PER_GB_MONTH](/docs/api-reference/std/build/billing/rate-card.md#files_sgd_per_gb_month)

***

<a id="hours_per_billing_month"></a>

### HOURS\_PER\_BILLING\_MONTH

Re-exports [HOURS_PER_BILLING_MONTH](/docs/api-reference/std/build/billing/rate-card.md#hours_per_billing_month)

***

<a id="local_cloud_rate_card"></a>

### LOCAL\_CLOUD\_RATE\_CARD

Re-exports [LOCAL_CLOUD_RATE_CARD](/docs/api-reference/std/build/billing/rate-card.md#local_cloud_rate_card)
