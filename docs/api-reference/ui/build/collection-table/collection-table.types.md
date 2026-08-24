[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table.types

# ui/build/collection-table/collection-table.types

## Interfaces

<a id="collectiontablecolumn"></a>

### CollectionTableColumn

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:32

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="card"></a>

##### card?

```ts
optional card?: "title" | "subtitle" | "badge";
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:43

Which auto-card slot this column feeds (title/subtitle/badge) when no `ListCard` is given.

<a id="hideable"></a>

##### hideable?

```ts
optional hideable?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:40

<a id="key"></a>

##### key

```ts
key: Extract<keyof TRow>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:33

<a id="label"></a>

##### label?

```ts
optional label?: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:34

<a id="maxwidth"></a>

##### maxWidth?

```ts
optional maxWidth?: number;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:37

<a id="minwidth"></a>

##### minWidth?

```ts
optional minWidth?: number;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:36

<a id="pinnable"></a>

##### pinnable?

```ts
optional pinnable?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:41

<a id="render"></a>

##### render?

```ts
optional render?: (context) => unknown;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:44

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | \{ `field`: [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield); `row`: `TRow`; `value`: `unknown`; \} |
| `context.field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |
| `context.row` | `TRow` |
| `context.value` | `unknown` |

###### Returns

`unknown`

<a id="resizable"></a>

##### resizable?

```ts
optional resizable?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:39

<a id="sortable"></a>

##### sortable?

```ts
optional sortable?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:38

<a id="width"></a>

##### width?

```ts
optional width?: number;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:35

***

<a id="collectiontablecolumnscomposition"></a>

### CollectionTableColumnsComposition

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:64

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="column"></a>

##### Column

```ts
Column: CollectionTableColumnComponent<TRow>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:65

***

<a id="collectiontablefeatures"></a>

### CollectionTableFeatures

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:67

#### Properties

<a id="create"></a>

##### create?

```ts
readonly optional create?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:70

<a id="filter"></a>

##### filter?

```ts
readonly optional filter?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:69

<a id="search"></a>

##### search?

```ts
readonly optional search?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:68

***

<a id="collectiontableinitialfilter"></a>

### CollectionTableInitialFilter

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:20

A filter condition the view opens with, seeded into the filter builder as an ordinary row.

This is the *builder's* vocabulary, not the wire's: `field` is the same path the field picker
uses (`effective_range`, or `relation.field`), and `value` is what the operand editor would
produce — a calendar day for `contains_date`, which `collectionFilterClause` converts to an
instant on its way out. Seeding the wire shape instead would mean reversing that conversion, and
unwrapping the `%…%` an `ilike` operand is published with.

A seed is a *default*, not a constraint. It arrives as a normal chip the operator can edit or
remove, and removing it is remembered per view — unlike a condition baked into `query.where`,
which is invisible, locked, and can only be narrated by the "Applied by this view" tooltip.

#### Properties

<a id="field"></a>

##### field

```ts
readonly field: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:22

Field path as the picker addresses it: `status`, or `agreement_employment.employee_number`.

<a id="operator"></a>

##### operator

```ts
readonly operator: CollectionFilterOperator;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:23

<a id="value"></a>

##### value?

```ts
readonly optional value?: unknown;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:25

Omitted for the operators that take none (`isNull`, `isNotNull`).

***

<a id="collectiontablepipeline"></a>

### CollectionTablePipeline

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:76

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="description"></a>

##### description?

```ts
readonly optional description?: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:79

<a id="getdisabledreason"></a>

##### getDisabledReason?

```ts
readonly optional getDisabledReason?: (selectedRows) => string | null;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:84

Returns user-facing copy when the current selection cannot run this pipeline.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `selectedRows` | readonly `TRow`[] |

###### Returns

`string` \| `null`

<a id="icon"></a>

##### icon?

```ts
readonly optional icon?: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:80

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:77

<a id="label-1"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:78

<a id="requiresselection"></a>

##### requiresSelection?

```ts
readonly optional requiresSelection?: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:82

Keeps the pipeline visible but muted until at least one row is selected.

#### Methods

<a id="run"></a>

##### run()

```ts
run(context): Effect<unknown, unknown>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:85

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`CollectionTablePipelineContext`](/docs/api-reference/ui/build/collection-table/collection-table.types.md#collectiontablepipelinecontext)\<`TRow`\> |

###### Returns

`Effect`\<`unknown`, `unknown`\>

***

<a id="collectiontablepipelinecontext"></a>

### CollectionTablePipelineContext

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:72

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="collectionname"></a>

##### collectionName

```ts
readonly collectionName: string;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:73

<a id="selectedrows"></a>

##### selectedRows

```ts
readonly selectedRows: readonly TRow[];
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:74

***

<a id="collectiontablerowactioncontext"></a>

### CollectionTableRowActionContext

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:57

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="hovered"></a>

##### hovered

```ts
hovered: boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:59

<a id="metadata"></a>

##### metadata

```ts
metadata: readonly ResolvedCollectionRecordMetadata[];
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:60

<a id="row"></a>

##### row

```ts
row: TRow;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:58

## Type Aliases

<a id="collectionname-1"></a>

### CollectionName

```ts
type CollectionName<TCollections> = Extract<keyof TCollections, string>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:6

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |

***

<a id="collectiontablecolumnprimitiveprops"></a>

### CollectionTableColumnPrimitiveProps

```ts
type CollectionTableColumnPrimitiveProps<TRow> = Omit<CollectionTableColumn<TRow>, "key"> & object;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:54

#### Type Declaration

##### name

```ts
name: CollectionTableFieldName<TRow>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

***

<a id="collectiontableintegrationstate"></a>

### CollectionTableIntegrationState

```ts
type CollectionTableIntegrationState = typeof collectionTableIntegrationStateSchema.Type;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:88

***

<a id="collectiontableintegrationstatus"></a>

### CollectionTableIntegrationStatus

```ts
type CollectionTableIntegrationStatus = typeof collectionTableIntegrationStatusSchema.Type;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:96

***

<a id="collectiontableprops"></a>

### CollectionTableProps

```ts
type CollectionTableProps<TCollections, TName, TRow> = CollectionTableBaseProps<TCollections, TName, TRow>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:148

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) | [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
| `TName` *extends* [`CollectionName`](/docs/api-reference/ui/build/collection-table/collection-table.types.md#collectionname-1)\<`TCollections`\> | [`CollectionName`](/docs/api-reference/ui/build/collection-table/collection-table.types.md#collectionname-1)\<`TCollections`\> |
| `TRow` *extends* `object` | [`CollectionTableRow`](/docs/api-reference/ui/build/collection-table/collection-table.types.md#collectiontablerow)\<`TCollections`, `TName`\> |

***

<a id="collectiontablerow"></a>

### CollectionTableRow

```ts
type CollectionTableRow<TCollections, TName> = CollectionRow<TCollections[TName]>;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:27

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
| `TName` *extends* [`CollectionName`](/docs/api-reference/ui/build/collection-table/collection-table.types.md#collectionname-1)\<`TCollections`\> |

## Functions

<a id="collectiontablecolumncansort"></a>

### collectionTableColumnCanSort()

```ts
function collectionTableColumnCanSort(field, options): boolean;
```

Defined in: packages/ui/build/collection-table/collection-table.types.d.ts:53

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |
| `options` | `CollectionTableSortability` |

#### Returns

`boolean`
