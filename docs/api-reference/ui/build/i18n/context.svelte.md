[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/i18n/context.svelte

# ui/build/i18n/context.svelte

## Interfaces

<a id="i18napi"></a>

### I18nApi

Defined in: packages/ui/build/i18n/context.svelte.d.ts:3

The translation API a component consumes. `Keys` is the catalog key union.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Keys` *extends* `string` | `string` |

#### Properties

<a id="intllocale"></a>

##### intlLocale

```ts
readonly intlLocale: string;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:9

The `Intl.*` locale string for the active locale (`en-US` / `zh-CN`).

<a id="locale"></a>

##### locale

```ts
readonly locale: string;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:5

The active application locale.

<a id="locales"></a>

##### locales

```ts
readonly locales: readonly string[];
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:7

The locale order the catalogs ship (toggle order, primary first).

<a id="t"></a>

##### t

```ts
readonly t: (key, vars?) => string;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:11

Translate a typed key, with `{placeholder}` interpolation.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `Keys` |
| `vars?` | `Readonly`\<`Record`\<`string`, `string` \| `number`\>\> |

###### Returns

`string`

#### Methods

<a id="has"></a>

##### has()

```ts
has(key): key is Keys;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:13

True when the key exists in any locale of the catalog set.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

###### Returns

`key is Keys`

<a id="setlocale"></a>

##### setLocale()

```ts
setLocale(locale): void;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:15

Switch the active locale; persists the choice and sets `<html lang>`.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

###### Returns

`void`

## Functions

<a id="getgloballocale"></a>

### getGlobalLocale()

```ts
function getGlobalLocale(): string;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:41

#### Returns

`string`

***

<a id="providei18n"></a>

### provideI18n()

```ts
function provideI18n<C>(catalogs, initialLocale?): I18nApi<KeysOf<C>>;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:26

Install the application's catalog pair and initial locale for the whole
component subtree. Call once from an application root during component init;
the Bolt workspace shell is the caller, merging the tenant's catalogs over
`uiMessages` before handing them here.

The initial locale resolves as: persisted choice, browser languages, then
English.

#### Type Parameters

| Type Parameter |
| ------ |
| `C` *extends* `Readonly`\<`Record`\<`string`, `Readonly`\<`Record`\<`string`, `string`\>\>\>\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `catalogs` | `C` |
| `initialLocale?` | `string` |

#### Returns

[`I18nApi`](/docs/api-reference/ui/build/i18n/context.svelte.md#i18napi)\<[`KeysOf`](/docs/api-reference/std/build/i18n/catalog.md#keysof)\<`C`\>\>

***

<a id="setgloballocale"></a>

### setGlobalLocale()

```ts
function setGlobalLocale(locale): void;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:40

Switch the ui package's fallback locale for apps that do not install a
provider (only possible once `@norbital-ai/ui` ships the i18n module).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `locale` | `string` |

#### Returns

`void`

***

<a id="usei18n"></a>

### useI18n()

```ts
function useI18n<Keys>(): I18nApi<Keys>;
```

Defined in: packages/ui/build/i18n/context.svelte.d.ts:35

Read the translation API from context.

Falls back to the ui package's own catalog and a module-level global locale
(see `setGlobalLocale`) when no provider is installed — which keeps
components renderable in isolation and lets apps without the context
mechanism still switch the shared ui chrome.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Keys` *extends* `string` | `string` |

#### Returns

[`I18nApi`](/docs/api-reference/ui/build/i18n/context.svelte.md#i18napi)\<`Keys`\>
