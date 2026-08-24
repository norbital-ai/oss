[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/i18n/locale

# std/build/i18n/locale

## Variables

<a id="default_locale"></a>

### DEFAULT\_LOCALE

```ts
const DEFAULT_LOCALE: "en" = "en";
```

Defined in: packages/std/build/i18n/locale.d.ts:16

The fallback locale when no stored or detected choice exists.

***

<a id="intl_locales"></a>

### INTL\_LOCALES

```ts
const INTL_LOCALES: Readonly<Record<string, string>>;
```

Defined in: packages/std/build/i18n/locale.d.ts:18

The Intl locale each application locale maps to for `Intl.*` formatting.

***

<a id="stored_locale_key"></a>

### STORED\_LOCALE\_KEY

```ts
const STORED_LOCALE_KEY: "norbital.locale" = "norbital.locale";
```

Defined in: packages/std/build/i18n/locale.d.ts:25

Browser/localStorage key under which a viewer's locale choice is persisted.

***

<a id="supported_locales"></a>

### SUPPORTED\_LOCALES

```ts
const SUPPORTED_LOCALES: readonly string[];
```

Defined in: packages/std/build/i18n/locale.d.ts:14

The supported application locales, in toggle order. English is the source-of-truth catalog.

## Functions

<a id="intllocale"></a>

### intlLocale()

```ts
function intlLocale(locale): string;
```

Defined in: packages/std/build/i18n/locale.d.ts:23

The Intl locale string for an application locale, falling back to the raw
code so an unmapped locale still formats sensibly.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

#### Returns

`string`

***

<a id="parselocale"></a>

### parseLocale()

```ts
function parseLocale(value): string | null;
```

Defined in: packages/std/build/i18n/locale.d.ts:33

Parse a BCP-47 tag into an application locale, or null.

`zh-CN`, `zh-TW`, and `zh-Hans` all resolve to `zh`; anything whose primary
subtag is not a supported locale resolves to null. Malformed values resolve
to null — never to a guessed locale, so callers keep their fallback chain.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` \| `null` \| `undefined` |

#### Returns

`string` \| `null`

***

<a id="picklocale"></a>

### pickLocale()

```ts
function pickLocale(candidates, fallback?): string;
```

Defined in: packages/std/build/i18n/locale.d.ts:38

Pick the first supported locale from an ordered candidate list (typically
`navigator.languages` or an `Accept-Language` header).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidates` | readonly `string`[] \| `null` \| `undefined` |
| `fallback?` | `string` |

#### Returns

`string`

***

<a id="sethtmllang"></a>

### setHtmlLang()

```ts
function setHtmlLang(locale): void;
```

Defined in: packages/std/build/i18n/locale.d.ts:44

Set the document language attribute. Safe in non-browser environments.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

#### Returns

`void`

***

<a id="storedlocale"></a>

### storedLocale()

```ts
function storedLocale(storage?): string | null;
```

Defined in: packages/std/build/i18n/locale.d.ts:40

Read the persisted locale, if any. Safe in non-browser environments.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `storage?` | `Pick`\<`Storage`, `"getItem"`\> \| `null` |

#### Returns

`string` \| `null`

***

<a id="storelocale"></a>

### storeLocale()

```ts
function storeLocale(locale, storage?): void;
```

Defined in: packages/std/build/i18n/locale.d.ts:42

Persist the locale choice. Safe in non-browser environments.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |
| `storage?` | `Pick`\<`Storage`, `"setItem"`\> \| `null` |

#### Returns

`void`
