[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-form/collection-form-values

# ui/build/collection-form/collection-form-values

## Functions

<a id="pickwritableformvalues"></a>

### pickWritableFormValues()

```ts
function pickWritableFormValues(fields, values): Record<string, unknown>;
```

Defined in: packages/ui/build/collection-form/collection-form-values.d.ts:10

Keeps only values the collection form is allowed to send back to a mutation.

An edit form starts from a complete hydrated row so it can render field values and framework
metadata. The mutation boundary is deliberately narrower: Bolt-managed columns and generated
authored columns are read context, never write input. Picking through the catalog here also keeps
an undeclared key from a custom form composition from becoming an accidental graph mutation.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |
| `values` | `Readonly`\<`Record`\<`string`, `unknown`\>\> |

#### Returns

`Record`\<`string`, `unknown`\>
