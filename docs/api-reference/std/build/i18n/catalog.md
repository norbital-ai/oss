[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/i18n/catalog

# std/build/i18n/catalog

## Type Aliases

<a id="keysof"></a>

### KeysOf

```ts
type KeysOf<C> = keyof C[keyof C] & string;
```

Defined in: packages/std/build/i18n/catalog.d.ts:26

Extract the key union of a catalog set, for typing `t`.

The intersection over the per-locale key sets: with parity this is the
shared key set, and a key missing from any locale drops out of the union and
becomes a compile-time error at its call site.

#### Type Parameters

| Type Parameter |
| ------ |
| `C` *extends* [`LocaleCatalogs`](/docs/api-reference/std/build/i18n/catalog.md#localecatalogs) |

***

<a id="localecatalogs"></a>

### LocaleCatalogs

```ts
type LocaleCatalogs = Readonly<Record<string, MessageCatalog>>;
```

Defined in: packages/std/build/i18n/catalog.d.ts:16

A complete set of message catalogs, keyed by application locale.

***

<a id="messagecatalog"></a>

### MessageCatalog

```ts
type MessageCatalog = Readonly<Record<string, string>>;
```

Defined in: packages/std/build/i18n/catalog.d.ts:14

Flat, dot-namespaced message catalogs.

A catalog is a flat `Record<string, string>`; namespacing is a key
convention (`table.emptyState`, `form.required`), never nested structure, so
catalogs merge and override by spread with no shape surprises.

A catalog record carries every supported locale. `defineMessages` enforces
exact key parity between locales: the runtime falls back locale -> primary
(`DEFAULT_LOCALE`) -> key, and `KeysOf` intersects the per-locale key sets,
so a key missing from any locale is a compile-time error at the first
`t(...)` call. English is the source of truth.

***

<a id="messagevars"></a>

### MessageVars

```ts
type MessageVars = Readonly<Record<string, string | number>>;
```

Defined in: packages/std/build/i18n/catalog.d.ts:18

Interpolation variables for a message template.

## Functions

<a id="definemessages"></a>

### defineMessages()

```ts
function defineMessages<C>(catalogs): C;
```

Defined in: packages/std/build/i18n/catalog.d.ts:44

Define a set of message catalogs with exact key parity between locales.

The primary catalog (keyed by `DEFAULT_LOCALE`, conventionally `en`) is the
source of truth; every other locale must carry exactly the same keys, which
`KeysOf` enforces at compile time. The runtime check keeps a mismatched
catalog from silently shipping when the type contract is bypassed (e.g. a
JSON round trip).

#### Type Parameters

| Type Parameter |
| ------ |
| `C` *extends* `Readonly`\<`Record`\<`string`, `Readonly`\<`Record`\<`string`, `string`\>\>\>\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `catalogs` | `C` |

#### Returns

`C`

***

<a id="interpolate"></a>

### interpolate()

```ts
function interpolate(template, vars?): string;
```

Defined in: packages/std/build/i18n/catalog.d.ts:34

Substitute `{name}` placeholders in a template.

Unknown or null-ish variables interpolate as empty strings rather than
throwing: a missing variable is a copy bug, not a runtime failure worth
crashing a screen over.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `template` | `string` |
| `vars?` | `Readonly`\<`Record`\<`string`, `string` \| `number`\>\> |

#### Returns

`string`

***

<a id="translate"></a>

### translate()

```ts
function translate(
   catalogs,
   locale,
   key,
   vars?): string;
```

Defined in: packages/std/build/i18n/catalog.d.ts:48

Pure lookup: translate `key` in `locale`, falling back locale -> primary -> key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `catalogs` | [`LocaleCatalogs`](/docs/api-reference/std/build/i18n/catalog.md#localecatalogs) |
| `locale` | `string` |
| `key` | `string` |
| `vars?` | `Readonly`\<`Record`\<`string`, `string` \| `number`\>\> |

#### Returns

`string`
