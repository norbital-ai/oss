[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/collection/record-label

# std/build/collection/record-label

## Functions

<a id="labeltermtext"></a>

### labelTermText()

```ts
function labelTermText(value): string | null;
```

Defined in: packages/std/build/collection/record-label.d.ts:10

Render one label term as text, or null when it has nothing to contribute.

CEL cannot do this itself. Its `+` has no overload but string+string, and `string()` has no
overload for timestamps or null — so a label naming a `date()` column, a number, a boolean or an
empty field throws instead of concatenating, however the expression is written. Coercion
therefore belongs here, where the values are ordinary JavaScript and a missing one can simply be
left out.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

#### Returns

`string` \| `null`

***

<a id="resolverecordlabel"></a>

### resolveRecordLabel()

```ts
function resolveRecordLabel(recordLabelExpression, record): string | null;
```

Defined in: packages/std/build/collection/record-label.d.ts:18

The title a record reads as, from the CEL expression its collection declares as `recordLabel`.

Null means the record cannot name itself — no expression, or nothing the expression touched had
any text to give. A caller decides what to show instead; this never invents a stand-in, and in
particular never falls back to a primary key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `recordLabelExpression` | `string` \| `null` |
| `record` | `object` |

#### Returns

`string` \| `null`
