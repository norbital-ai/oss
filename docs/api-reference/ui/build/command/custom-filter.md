[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/command/custom-filter

# ui/build/command/custom-filter

## Functions

<a id="buildcustomfilterfn"></a>

### buildCustomFilterFn()

```ts
function buildCustomFilterFn<T, AP>(options): (optionValue, search) => number;
```

Defined in: packages/ui/build/command/custom-filter.d.ts:2

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `AP` *extends* `Record`\<`string`, `unknown`\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`TOption`](/docs/api-reference/ui/build/combobox.md#toption)\<`T`, `AP`\>[] |

#### Returns

(`optionValue`, `search`) => `number`
