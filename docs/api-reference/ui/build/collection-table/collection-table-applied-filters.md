[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table-applied-filters

# ui/build/collection-table/collection-table-applied-filters

## Interfaces

<a id="collectionappliedfiltercondition"></a>

### CollectionAppliedFilterCondition

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:3

#### Properties

<a id="alternative"></a>

##### alternative

```ts
readonly alternative: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:10

<a id="field"></a>

##### field

```ts
readonly field: CollectionField;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:5

<a id="key"></a>

##### key

```ts
readonly key: string;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:4

<a id="label"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:6

<a id="lookuptarget"></a>

##### lookupTarget?

```ts
readonly optional lookupTarget?: string;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:11

<a id="negated"></a>

##### negated

```ts
readonly negated: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:9

<a id="operand"></a>

##### operand

```ts
readonly operand: unknown;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:8

<a id="operator"></a>

##### operator

```ts
readonly operator: string;
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:7

## Functions

<a id="collectionappliedfilterconditions"></a>

### collectionAppliedFilterConditions()

```ts
function collectionAppliedFilterConditions(
   where,
   definition,
   collections): readonly CollectionAppliedFilterCondition[];
```

Defined in: packages/ui/build/collection-table/collection-table-applied-filters.d.ts:20

Turn an authored `where` tree into schema-bearing conditions for the table's about popover.

Keeping the field metadata is the important difference from a string description: the value can
now use the same datatype renderer as the filter builder, while relationship keys can resolve to
their record labels instead of leaking UUIDs.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `where` | `unknown` |
| `definition` | [`FilterCollectionDefinition`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#filtercollectiondefinition) |
| `collections` | `Readonly`\<`Record`\<`string`, [`FilterCollectionDefinition`](/docs/api-reference/ui/build/collection-table/collection-table-filter-fields.md#filtercollectiondefinition)\>\> |

#### Returns

readonly [`CollectionAppliedFilterCondition`](/docs/api-reference/ui/build/collection-table/collection-table-applied-filters.md#collectionappliedfiltercondition)[]
