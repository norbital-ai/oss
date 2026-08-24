[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/phone\_number/phone\_number.utils

# ui/build/data-renderer/phone\_number/phone\_number.utils

## Functions

<a id="changephonecountry"></a>

### changePhoneCountry()

```ts
function changePhoneCountry(
   value,
   currentCountry,
   nextCountry): string;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:17

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `currentCountry` | `CountryCode` |
| `nextCountry` | `CountryCode` |

#### Returns

`string`

***

<a id="formatphonedisplay"></a>

### formatPhoneDisplay()

```ts
function formatPhoneDisplay(value, country): string;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:16

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `country` | `CountryCode` |

#### Returns

`string`

***

<a id="formatphoneinput"></a>

### formatPhoneInput()

```ts
function formatPhoneInput(value, country): string;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:11

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `country` | `CountryCode` |

#### Returns

`string`

***

<a id="normalizephonevalue"></a>

### normalizePhoneValue()

```ts
function normalizePhoneValue(value, country): string | null;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:15

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `country` | `CountryCode` |

#### Returns

`string` \| `null`

***

<a id="phonecountryfromlocale"></a>

### phoneCountryFromLocale()

```ts
function phoneCountryFromLocale(locale): CountryCode;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

#### Returns

`CountryCode`

***

<a id="phonecountryoptions"></a>

### phoneCountryOptions()

```ts
function phoneCountryOptions(locale): PhoneCountryOption[];
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:9

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

#### Returns

`PhoneCountryOption`[]

***

<a id="phoneinputplaceholder"></a>

### phoneInputPlaceholder()

```ts
function phoneInputPlaceholder(country, fallback?): string;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:14

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `country` | `CountryCode` |
| `fallback?` | `string` |

#### Returns

`string`

***

<a id="resolvephonecountry"></a>

### resolvePhoneCountry()

```ts
function resolvePhoneCountry(value, fallback): CountryCode;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:10

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `fallback` | `CountryCode` |

#### Returns

`CountryCode`

***

<a id="sanitizephoneinput"></a>

### sanitizePhoneInput()

```ts
function sanitizePhoneInput(value): string;
```

Defined in: packages/ui/build/data-renderer/phone\_number/phone\_number.utils.d.ts:13

Keep only an optional leading plus and the E.164 maximum of 15 digits.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`string`
