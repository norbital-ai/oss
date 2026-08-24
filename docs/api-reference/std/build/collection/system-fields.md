[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/collection/system-fields

# std/build/collection/system-fields

## Variables

<a id="issystemcollectionfield"></a>

### isSystemCollectionField

```ts
const isSystemCollectionField: (name) => boolean;
```

Defined in: packages/std/build/collection/system-fields.d.ts:4

Whether a field is compiler-owned rather than authored by a workspace model.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |

#### Returns

`boolean`

***

<a id="system_collection_field_names"></a>

### SYSTEM\_COLLECTION\_FIELD\_NAMES

```ts
const SYSTEM_COLLECTION_FIELD_NAMES: ReadonlyArray<string>;
```

Defined in: packages/std/build/collection/system-fields.d.ts:2

Framework-owned fields added to every collection by the shared model compiler.
