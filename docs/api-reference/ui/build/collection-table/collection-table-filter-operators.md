[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table-filter-operators

# ui/build/collection-table/collection-table-filter-operators

## Type Aliases

<a id="collectionfilteroperator"></a>

### CollectionFilterOperator

```ts
type CollectionFilterOperator =
  | CollectionFilter["operator"]
  | "contains";
```

Defined in: packages/ui/build/collection-table/collection-table-filter-operators.d.ts:2

## Functions

<a id="collectionfilteroperandfield"></a>

### collectionFilterOperandField()

```ts
function collectionFilterOperandField(field, operator): CollectionField;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-operators.d.ts:9

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |
| `operator` | [`CollectionFilterOperator`](/docs/api-reference/ui/build/collection-table/collection-table-filter-operators.md#collectionfilteroperator) |

#### Returns

[`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)

***

<a id="collectionfilteroperatorneedsvalue"></a>

### collectionFilterOperatorNeedsValue()

```ts
function collectionFilterOperatorNeedsValue(operator): boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-filter-operators.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operator` | [`CollectionFilterOperator`](/docs/api-reference/ui/build/collection-table/collection-table-filter-operators.md#collectionfilteroperator) |

#### Returns

`boolean`

***

<a id="collectionfilteroperatoroptions"></a>

### collectionFilterOperatorOptions()

```ts
function collectionFilterOperatorOptions(field): readonly CollectionFilterOperatorOption[];
```

Defined in: packages/ui/build/collection-table/collection-table-filter-operators.d.ts:7

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |

#### Returns

readonly `CollectionFilterOperatorOption`[]

***

<a id="collectionfilterqueryoperator"></a>

### collectionFilterQueryOperator()

```ts
function collectionFilterQueryOperator(field, operator):
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "ilike"
  | "isNull"
  | "isNotNull"
  | "arrayContains"
  | "arrayOverlaps"
  | "contains_date"
  | "overlaps";
```

Defined in: packages/ui/build/collection-table/collection-table-filter-operators.d.ts:10

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |
| `operator` | [`CollectionFilterOperator`](/docs/api-reference/ui/build/collection-table/collection-table-filter-operators.md#collectionfilteroperator) |

#### Returns

  \| `"eq"`
  \| `"ne"`
  \| `"gt"`
  \| `"gte"`
  \| `"lt"`
  \| `"lte"`
  \| `"ilike"`
  \| `"isNull"`
  \| `"isNotNull"`
  \| `"arrayContains"`
  \| `"arrayOverlaps"`
  \| `"contains_date"`
  \| `"overlaps"`
