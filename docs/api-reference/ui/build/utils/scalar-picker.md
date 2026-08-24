[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/utils/scalar-picker

# ui/build/utils/scalar-picker

## Functions

<a id="removescalarrow"></a>

### removeScalarRow()

```ts
function removeScalarRow(
   rows,
   index,
   multiple): number[];
```

Defined in: packages/ui/build/utils/scalar-picker.d.ts:11

Drop the row at `index`. A single-value picker keeps its one row and clears it instead.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rows` | readonly `number`[] |
| `index` | `number` |
| `multiple` | `boolean` |

#### Returns

`number`[]

***

<a id="scalarpickerpayload"></a>

### scalarPickerPayload()

```ts
function scalarPickerPayload(meaningful, multiple): number | number[] | null;
```

Defined in: packages/ui/build/utils/scalar-picker.d.ts:9

What the picker reports upward: every meaningful row, or only the first one.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `meaningful` | readonly `number`[] |
| `multiple` | `boolean` |

#### Returns

`number` \| `number`[] \| `null`
