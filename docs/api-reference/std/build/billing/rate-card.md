[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/billing/rate-card

# std/build/billing/rate-card

## Type Aliases

<a id="billingaccesstier"></a>

### BillingAccessTier

```ts
type BillingAccessTier = typeof BILLING_ACCESS_TIERS[number];
```

Defined in: packages/std/build/billing/rate-card.d.ts:3

## Variables

<a id="ai_sgd_per_provider_usd"></a>

### AI\_SGD\_PER\_PROVIDER\_USD

```ts
const AI_SGD_PER_PROVIDER_USD: 2.6 = 2.6;
```

Defined in: packages/std/build/billing/rate-card.d.ts:33

SGD charged per US dollar of provider spend.

AI is not priced from a token table of our own. The provider reports what a call cost and that
figure is converted with this rate, so the meter tracks provider pricing directly and moves with
it instead of needing a re-audit every time a model's price changes.

The rate is a loaded one, not a currency conversion. Spot USD/SGD is well under half of it; the
rest is deliberate cover for everything between what a provider charges us and what reaches the
bank — the fee on buying provider credit, FX spread on top of spot, card and payout fees on the
tenant's invoice, and a margin over all of it. Every one of those moves on somebody else's
schedule, so the cover is set generously rather than tracked.

It stays one number and not a chain of multipliers. A factored form lived here, evaluated to 1.55,
and was called by nothing while the meter that reaches Stripe charged 2.60 — two answers to the
same question, the uninvoiced one looking every bit as authoritative. A split that is not itself
billed is documentation, and documentation belongs in this comment rather than in arithmetic that
can drift away from the price.

***

<a id="billing_access_tiers"></a>

### BILLING\_ACCESS\_TIERS

```ts
const BILLING_ACCESS_TIERS: readonly ["standard", "builder"];
```

Defined in: packages/std/build/billing/rate-card.d.ts:2

***

<a id="billing_rate_card_version"></a>

### BILLING\_RATE\_CARD\_VERSION

```ts
const BILLING_RATE_CARD_VERSION: "2026-08-18" = "2026-08-18";
```

Defined in: packages/std/build/billing/rate-card.d.ts:1

***

<a id="compute_sgd_per_second"></a>

### COMPUTE\_SGD\_PER\_SECOND

```ts
const COMPUTE_SGD_PER_SECOND: 0.0005 = 0.0005;
```

Defined in: packages/std/build/billing/rate-card.d.ts:10

Tenant-visible usage prices. Compute is worker-thread event-loop utilization (ELU) active time,
billed in seconds. Memory has no separate usage meter or per-worker hard wall; its infrastructure
cost is included in the compute price.
Disc and files are GB-months converted to GB-hours over a 730-hour month.

***

<a id="disc_sgd_per_gb_month"></a>

### DISC\_SGD\_PER\_GB\_MONTH

```ts
const DISC_SGD_PER_GB_MONTH: 3 = 3;
```

Defined in: packages/std/build/billing/rate-card.d.ts:11

***

<a id="external_cloud_rate_card_usd"></a>

### EXTERNAL\_CLOUD\_RATE\_CARD\_USD

```ts
const EXTERNAL_CLOUD_RATE_CARD_USD: object;
```

Defined in: packages/std/build/billing/rate-card.d.ts:51

#### Type Declaration

<a id="neoncomputepercuhour"></a>

##### neonComputePerCuHour

```ts
readonly neonComputePerCuHour: 0.106;
```

<a id="neonextrabranchperhour"></a>

##### neonExtraBranchPerHour

```ts
readonly neonExtraBranchPerHour: 0.002;
```

<a id="neonrestorepergbmonth"></a>

##### neonRestorePerGbMonth

```ts
readonly neonRestorePerGbMonth: 0.2;
```

<a id="neonstoragepergbmonth"></a>

##### neonStoragePerGbMonth

```ts
readonly neonStoragePerGbMonth: 0.35;
```

<a id="r2classapermillion"></a>

##### r2ClassAPerMillion

```ts
readonly r2ClassAPerMillion: 4.5;
```

<a id="r2classbpermillion"></a>

##### r2ClassBPerMillion

```ts
readonly r2ClassBPerMillion: 0.36;
```

<a id="r2storagepergbmonth"></a>

##### r2StoragePerGbMonth

```ts
readonly r2StoragePerGbMonth: 0.015;
```

***

<a id="files_sgd_per_gb_month"></a>

### FILES\_SGD\_PER\_GB\_MONTH

```ts
const FILES_SGD_PER_GB_MONTH: 0.25 = 0.25;
```

Defined in: packages/std/build/billing/rate-card.d.ts:12

***

<a id="hours_per_billing_month"></a>

### HOURS\_PER\_BILLING\_MONTH

```ts
const HOURS_PER_BILLING_MONTH: 730 = 730;
```

Defined in: packages/std/build/billing/rate-card.d.ts:13

***

<a id="local_cloud_rate_card"></a>

### LOCAL\_CLOUD\_RATE\_CARD

```ts
const LOCAL_CLOUD_RATE_CARD: object;
```

Defined in: packages/std/build/billing/rate-card.d.ts:39

Local bare-metal cost allocation, kept for capacity planning. It is not a customer-facing meter
split: the compute price includes RAM cost, while measured usage remains worker-thread ELU active
time.

#### Type Declaration

<a id="allocation"></a>

##### allocation

```ts
readonly allocation: object;
```

###### allocation.cpu

```ts
readonly cpu: 0.4;
```

###### allocation.disk

```ts
readonly disk: 0.25;
```

###### allocation.ram

```ts
readonly ram: 0.35;
```

<a id="cpucores"></a>

##### cpuCores

```ts
readonly cpuCores: 6;
```

<a id="diskgb"></a>

##### diskGb

```ts
readonly diskGb: 894;
```

<a id="hourspermonth"></a>

##### hoursPerMonth

```ts
readonly hoursPerMonth: 730;
```

<a id="ramgb"></a>

##### ramGb

```ts
readonly ramGb: 32;
```

<a id="servermonthlycostsgd"></a>

##### serverMonthlyCostSgd

```ts
readonly serverMonthlyCostSgd: 149.99;
```
