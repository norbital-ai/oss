[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table-filter-fields

# ui/build/collection-table/collection-table-filter-fields

## Interfaces

<a id="collectionfilterfield"></a>

### CollectionFilterField

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:10

#### Properties

<a id="field"></a>

##### field

```ts
readonly field: CollectionField;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:12

<a id="relation"></a>

##### relation?

```ts
readonly optional relation?: object;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:13

###### cardinality

```ts
readonly cardinality: "one" | "many";
```

###### name

```ts
readonly name: string;
```

###### target

```ts
readonly target: string;
```

<a id="value"></a>

##### value

```ts
readonly value: string;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:11

***

<a id="filtercollectiondefinition"></a>

### FilterCollectionDefinition

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:4

#### Properties

<a id="fields"></a>

##### fields

```ts
readonly fields: readonly CollectionField<string>[];
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:6

<a id="name"></a>

##### name

```ts
readonly name: string;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:5

<a id="recordlabel"></a>

##### recordLabel?

```ts
readonly optional recordLabel?: string | null;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:7

<a id="relationships"></a>

##### relationships?

```ts
readonly optional relationships?: readonly CollectionRelationship[];
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:8

## Functions

<a id="collectionfilterclause"></a>

### collectionFilterClause()

```ts
function collectionFilterClause(
   filterField,
   operator,
   operand): CollectionFilter;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:21

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filterField` | [`CollectionFilterField`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#collectionfilterfield) |
| `operator` | \| `"eq"` \| `"ne"` \| `"gt"` \| `"gte"` \| `"lt"` \| `"lte"` \| `"ilike"` \| `"isNull"` \| `"isNotNull"` \| `"arrayContains"` \| `"arrayOverlaps"` \| `"contains_date"` \| `"overlaps"` |
| `operand` | `unknown` |

#### Returns

[`CollectionFilter`](/docs/api-reference/std/build/collection.md#collectionfilter)

***

<a id="collectionfilterfields"></a>

### collectionFilterFields()

```ts
function collectionFilterFields(definition, collections): readonly CollectionFilterField[];
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:20

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | [`FilterCollectionDefinition`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#filtercollectiondefinition) |
| `collections` | `Readonly`\<`Record`\<`string`, [`FilterCollectionDefinition`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#filtercollectiondefinition)\>\> |

#### Returns

readonly [`CollectionFilterField`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#collectionfilterfield)[]

***

<a id="collectionfilterfieldtree"></a>

### collectionFilterFieldTree()

```ts
function collectionFilterFieldTree(filterFields, t?): readonly BaseTreeItem<
  | CollectionFilterField
  | null>[];
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:19

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filterFields` | readonly [`CollectionFilterField`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#collectionfilterfield)[] |
| `t?` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

readonly [`BaseTreeItem`](/docs/api-reference/ui/build/tree-select.md#basetreeitem)\<
  \| [`CollectionFilterField`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#collectionfilterfield)
  \| `null`\>[]

***

<a id="relationlabeloptions"></a>

### relationLabelOptions()

```ts
function relationLabelOptions(target, targetName): CollectionRelationOptions;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-fields.d.ts:23

Record keys need the target collection's record-label contract, not a UUID text input.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | \| \{ `recordLabel?`: `string` \| `null`; \} \| `undefined` |
| `targetName` | `string` |

#### Returns

[`CollectionRelationOptions`](/docs/api-reference/std/build/collection.md#collectionrelationoptions)
