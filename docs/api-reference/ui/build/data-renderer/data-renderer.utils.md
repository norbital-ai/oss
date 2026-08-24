[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/data-renderer.utils

# ui/build/data-renderer/data-renderer.utils

## Type Aliases

<a id="translate"></a>

### Translate

```ts
type Translate = (key, vars?) => string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.utils.d.ts:3

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `vars?` | [`MessageVars`](/docs/api-reference/std/build/i18n/catalog.md#messagevars) |

#### Returns

`string`

## Functions

<a id="formatdatavalue"></a>

### formatDataValue()

```ts
function formatDataValue(
   field,
   value,
   locale?,
   t?): string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.utils.d.ts:6

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |
| `value` | `unknown` |
| `locale?` | `string` |
| `t?` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

`string`

***

<a id="formatstructuredvalue"></a>

### formatStructuredValue()

```ts
function formatStructuredValue(value, pretty?): string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.utils.d.ts:5

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |
| `pretty?` | `boolean` |

#### Returns

`string`
