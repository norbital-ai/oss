[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/hash

# std/build/reckon/hash

## Functions

<a id="hashdefinition"></a>

### hashDefinition()

```ts
function hashDefinition(def): string;
```

Defined in: packages/std/build/reckon/hash.d.ts:2

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `def` | \{ `components?`: \{ \[`key`: `string`\]: `object`; \}; `dependsOn?`: readonly `string`[]; `exprs`: \{ \[`key`: `string`\]: `string`; \}; `id`: `string`; `outputs`: readonly `string`[]; `tables`: \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \}; \} | - |
| `def.components?` | \{ \[`key`: `string`\]: `object`; \} | Optional mapping from output expr ids to payslip component metadata. |
| `def.dependsOn?` | readonly `string`[] | Other computation definition ids whose outputs feed into this one's inputs. |
| `def.exprs` | \{ \[`key`: `string`\]: `string`; \} | Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. |
| `def.id` | `string` | Unique identifier for this definition. |
| `def.outputs` | readonly `string`[] | Which expr names are exposed as outputs. |
| `def.tables` | \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \} | Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. |

#### Returns

`string`

***

<a id="sha256json"></a>

### sha256Json()

```ts
function sha256Json(value): string;
```

Defined in: packages/std/build/reckon/hash.d.ts:3

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="sha256text"></a>

### sha256Text()

```ts
function sha256Text(message): string;
```

Defined in: packages/std/build/reckon/hash.d.ts:5

Hashes exact UTF-8 text without requiring a Node.js crypto runtime.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |

#### Returns

`string`
