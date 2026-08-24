[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/internal/collection-table-state.svelte

# ui/build/collection-table/internal/collection-table-state.svelte

## Classes

<a id="columnapi"></a>

### ColumnAPI

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:70

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | - |
| `TCondition` | `unknown` |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new ColumnAPI<T, TCondition>(init): ColumnAPI<T, TCondition>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:98

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `init` | `ColumnAPIOptions`\<`T`, `TCondition`\> |

###### Returns

[`ColumnAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#columnapi)\<`T`, `TCondition`\>

#### Properties

<a id="accessor"></a>

##### accessor?

```ts
optional accessor?: (row) => unknown;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:78

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | [`RowAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#rowapi)\<`T`, `TCondition`\> |

###### Returns

`unknown`

<a id="cell"></a>

##### cell?

```ts
optional cell?: (__namedParameters) => unknown;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:75

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `row`: [`RowAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#rowapi)\<`T`, `TCondition`\>; \} |
| `__namedParameters.row` | [`RowAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#rowapi)\<`T`, `TCondition`\> |

###### Returns

`unknown`

<a id="currentdisplay"></a>

##### currentDisplay?

```ts
optional currentDisplay?: string;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:86

<a id="displayoptions"></a>

##### displayOptions?

```ts
optional displayOptions?: object[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:82

###### label

```ts
label: string;
```

###### value

```ts
value: string;
```

<a id="enablehiding"></a>

##### enableHiding

```ts
enableHiding: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:92

<a id="enablepinning"></a>

##### enablePinning

```ts
enablePinning: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:90

<a id="enableresizing"></a>

##### enableResizing

```ts
enableResizing: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:91

<a id="enableselection"></a>

##### enableSelection

```ts
enableSelection: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:93

<a id="enablesorting"></a>

##### enableSorting

```ts
enableSorting: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:89

<a id="header"></a>

##### header

```ts
header: (__namedParameters) => unknown;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:72

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | \{ `table`: [`TableAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#tableapi)\<`T`, `TCondition`\>; \} |
| `__namedParameters.table` | [`TableAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#tableapi)\<`T`, `TCondition`\> |

###### Returns

`unknown`

<a id="id"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:71

<a id="initialwidth"></a>

##### initialWidth?

```ts
optional initialWidth?: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:79

<a id="ispinned"></a>

##### isPinned

```ts
isPinned: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:95

<a id="isvisible"></a>

##### isVisible

```ts
isVisible: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:94

<a id="maxwidth"></a>

##### maxWidth?

```ts
optional maxWidth?: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:81

<a id="minwidth"></a>

##### minWidth?

```ts
optional minWidth?: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:80

<a id="ondisplaychange"></a>

##### onDisplayChange?

```ts
optional onDisplayChange?: (value) => void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:87

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="sortdirection"></a>

##### sortDirection

```ts
sortDirection: "asc" | "desc" | undefined;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:97

<a id="width"></a>

##### width

```ts
width: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:96

#### Methods

<a id="setsize"></a>

##### setSize()

```ts
setSize(newSize): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:102

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `newSize` | `number` |

###### Returns

`void`

<a id="togglepin"></a>

##### togglePin()

```ts
togglePin(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:100

###### Returns

`void`

<a id="togglesort"></a>

##### toggleSort()

```ts
toggleSort(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:99

###### Returns

`void`

<a id="togglevisibility"></a>

##### toggleVisibility()

```ts
toggleVisibility(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:101

###### Returns

`void`

***

<a id="rowapi"></a>

### RowAPI

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:38

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | - |
| `TCondition` | `unknown` |

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new RowAPI<T, TCondition>(args): RowAPI<T, TCondition>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:45

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `RowAPIOptions`\<`T`, `TCondition`\> |

###### Returns

[`RowAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#rowapi)\<`T`, `TCondition`\>

#### Properties

<a id="id-1"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:39

<a id="index"></a>

##### index

```ts
index: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:40

<a id="isexpanded"></a>

##### isExpanded

```ts
isExpanded: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:44

<a id="isselected"></a>

##### isSelected

```ts
isSelected: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:43

<a id="raw"></a>

##### raw

```ts
raw: T;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:41

#### Methods

<a id="toggleexpanded"></a>

##### toggleExpanded()

```ts
toggleExpanded(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:47

###### Returns

`void`

<a id="toggleselection"></a>

##### toggleSelection()

```ts
toggleSelection(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:46

###### Returns

`void`

***

<a id="tableapi"></a>

### TableAPI

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:121

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | - |
| `TCondition` | `unknown` |

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new TableAPI<T, TCondition>(args): TableAPI<T, TCondition>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:163

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `TableAPIOptions`\<`T`, `TCondition`\> |

###### Returns

[`TableAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#tableapi)\<`T`, `TCondition`\>

#### Properties

<a id="checkbox_width"></a>

##### CHECKBOX\_WIDTH

```ts
readonly CHECKBOX_WIDTH: 48 = 48;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:122

<a id="columndisplay"></a>

##### columnDisplay

```ts
columnDisplay: TableState<Record<string, string>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:139

<a id="columnlayouts"></a>

##### columnLayouts

```ts
columnLayouts: object[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:152

###### canResize

```ts
canResize: boolean;
```

###### cssVar

```ts
cssVar: `--table-col-${string}-width`;
```

###### id

```ts
id: string;
```

###### index

```ts
index: number;
```

###### instance

```ts
instance: ColumnAPI<T, TCondition>;
```

###### isCheckbox

```ts
isCheckbox: boolean;
```

###### isPinned

```ts
isPinned: boolean;
```

###### leftOffset

```ts
leftOffset: number;
```

###### width

```ts
width: number;
```

<a id="columnorder"></a>

##### columnOrder

```ts
columnOrder: TableState<string[]>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:137

<a id="columns"></a>

##### columns

```ts
columns: ColumnAPI<T, TCondition>[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:141

<a id="columnsizing"></a>

##### columnSizing

```ts
columnSizing: TableState<Record<string, number>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:136

<a id="columnvisibility"></a>

##### columnVisibility

```ts
columnVisibility: TableState<Record<string, boolean>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:135

<a id="condition"></a>

##### condition

```ts
condition: TableState<TCondition>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:131

<a id="contentfitwidths"></a>

##### contentFitWidths

```ts
contentFitWidths: Record<string, number>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:140

<a id="data"></a>

##### data

```ts
data: T[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:129

<a id="default_width"></a>

##### DEFAULT\_WIDTH

```ts
readonly DEFAULT_WIDTH: 150 = 150;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:123

<a id="expanded"></a>

##### expanded

```ts
expanded: TableState<Record<string, boolean>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:134

<a id="isallpagerowsselected"></a>

##### isAllPageRowsSelected

```ts
isAllPageRowsSelected: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:149

<a id="issomepagerowsselected"></a>

##### isSomePageRowsSelected

```ts
isSomePageRowsSelected: boolean;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:150

<a id="orderedcolumns"></a>

##### orderedColumns

```ts
orderedColumns: ColumnAPI<T, TCondition>[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:151

<a id="pageselectionstate"></a>

##### pageSelectionState

```ts
pageSelectionState: object;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:144

###### isAllSelected

```ts
isAllSelected: boolean;
```

###### isSomeSelected

```ts
isSomeSelected: boolean;
```

###### selectedCount

```ts
selectedCount: number;
```

<a id="persistencekey"></a>

##### persistenceKey

```ts
persistenceKey: string;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:124

<a id="pinnedcolumns"></a>

##### pinnedColumns

```ts
pinnedColumns: TableState<Record<string, boolean>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:138

<a id="rowids"></a>

##### rowIds

```ts
rowIds: string[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:143

<a id="rowinstances"></a>

##### rowInstances

```ts
rowInstances: RowAPI<T, TCondition>[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:142

<a id="rowkey"></a>

##### rowKey

```ts
rowKey: keyof T;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:126

<a id="rowselection"></a>

##### rowSelection

```ts
rowSelection: TableState<Record<string, boolean>>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:133

<a id="sort"></a>

##### sort

```ts
sort: TableState<object[]>;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:132

<a id="totalrows"></a>

##### totalRows

```ts
totalRows: number;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:130

<a id="viewkey"></a>

##### viewKey

```ts
viewKey: string;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:125

#### Methods

<a id="createcolumnresizer"></a>

##### createColumnResizer()

```ts
createColumnResizer(options): object;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:194

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `ColumnResizerOptions` |

###### Returns

`object`

###### activeColumnId

```ts
readonly activeColumnId: string | null;
```

###### handle

```ts
handle: (event, id) => void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `MouseEvent` \| `TouchEvent` |
| `id` | `string` |

###### Returns

`void`

<a id="fitallcolumns"></a>

##### fitAllColumns()

```ts
fitAllColumns(): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:184

###### Returns

`void`

<a id="fitcolumn"></a>

##### fitColumn()

```ts
fitColumn(columnId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:183

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |

###### Returns

`void`

<a id="setcolumndisplay"></a>

##### setColumnDisplay()

```ts
setColumnDisplay(columnDisplay): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:188

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnDisplay` | `Record`\<`string`, `string`\> |

###### Returns

`void`

<a id="setcolumnorder"></a>

##### setColumnOrder()

```ts
setColumnOrder(order): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:191

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `order` | `string`[] |

###### Returns

`void`

<a id="setcolumns"></a>

##### setColumns()

```ts
setColumns(columns): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:187

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columns` | [`ColumnAPI`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#columnapi)\<`T`, `TCondition`\>[] |

###### Returns

`void`

<a id="setcolumnsize"></a>

##### setColumnSize()

```ts
setColumnSize(columnId, size): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:181

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |
| `size` | `number` |

###### Returns

`void`

<a id="setcondition"></a>

##### setCondition()

```ts
setCondition(condition): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:189

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `condition` | `TCondition` |

###### Returns

`void`

<a id="setcontentfitwidths"></a>

##### setContentFitWidths()

```ts
setContentFitWidths(widths, initialize): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:182

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `widths` | `Record`\<`string`, `number`\> |
| `initialize` | `boolean` |

###### Returns

`void`

<a id="setdata"></a>

##### setData()

```ts
setData(data): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:185

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `T`[] |

###### Returns

`void`

<a id="setexpanded"></a>

##### setExpanded()

```ts
setExpanded(expanded): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:193

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `expanded` | `Record`\<`string`, `boolean`\> |

###### Returns

`void`

<a id="setrowselection"></a>

##### setRowSelection()

```ts
setRowSelection(selection): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:192

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `selection` | `Record`\<`string`, `boolean`\> |

###### Returns

`void`

<a id="setsort"></a>

##### setSort()

```ts
setSort(sort): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:190

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `sort` | `object`[] |

###### Returns

`void`

<a id="settotalrows"></a>

##### setTotalRows()

```ts
setTotalRows(totalRows): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:186

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `totalRows` | `number` |

###### Returns

`void`

<a id="toggleallpagerowsselected"></a>

##### toggleAllPageRowsSelected()

```ts
toggleAllPageRowsSelected(select): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:177

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `select` | `boolean` |

###### Returns

`void`

<a id="togglecolumnpin"></a>

##### toggleColumnPin()

```ts
toggleColumnPin(columnId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:180

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |

###### Returns

`void`

<a id="togglecolumnvisibility"></a>

##### toggleColumnVisibility()

```ts
toggleColumnVisibility(columnId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:179

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |

###### Returns

`void`

<a id="togglerowexpanded"></a>

##### toggleRowExpanded()

```ts
toggleRowExpanded(rowId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:178

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `rowId` | `string` |

###### Returns

`void`

<a id="togglerowselection"></a>

##### toggleRowSelection()

```ts
toggleRowSelection(rowId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:176

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `rowId` | `string` |

###### Returns

`void`

<a id="togglesort-1"></a>

##### toggleSort()

```ts
toggleSort(columnId): void;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:175

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |

###### Returns

`void`

## Type Aliases

<a id="tablecallbacks"></a>

### TableCallbacks

```ts
type TableCallbacks<TCondition> = object;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:21

Optional callback handlers that are invoked when table state changes.
These allow parent components to react to state mutations without using
external `watch` or `$effect` patterns.

#### Type Parameters

| Type Parameter |
| ------ |
| `TCondition` |

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-oncolumnorderchange"></a> `onColumnOrderChange?` | (`order`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:28 |
| <a id="property-oncolumnsizingchange"></a> `onColumnSizingChange?` | (`sizing`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:27 |
| <a id="property-oncolumnvisibilitychange"></a> `onColumnVisibilityChange?` | (`visibility`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:26 |
| <a id="property-onconditionchange"></a> `onConditionChange?` | (`condition`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:25 |
| <a id="property-onexpandedchange"></a> `onExpandedChange?` | (`expandedIds`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:23 |
| <a id="property-onpinnedcolumnschange"></a> `onPinnedColumnsChange?` | (`pinned`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:29 |
| <a id="property-onselectionchange"></a> `onSelectionChange?` | (`selectedIds`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:22 |
| <a id="property-onsortchange"></a> `onSortChange?` | (`sort`) => `void` | packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:24 |

***

<a id="tablesortentry"></a>

### TableSortEntry

```ts
type TableSortEntry = typeof tableSortEntrySchema.Type;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:9

***

<a id="tcreatecolumnprops"></a>

### TCreateColumnProps

```ts
type TCreateColumnProps<T, TCondition> = Omit<ConstructorParameters<typeof ColumnAPI>["0"], "table">;
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:31

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | - |
| `TCondition` | `unknown` |

## Variables

<a id="collection_table_selection_column_id"></a>

### COLLECTION\_TABLE\_SELECTION\_COLUMN\_ID

```ts
const COLLECTION_TABLE_SELECTION_COLUMN_ID: "__selection";
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:10

## Functions

<a id="withselectioncolumn"></a>

### withSelectionColumn()

```ts
function withSelectionColumn<TData, TCondition>(
   cols,
   enabled,
   t?): TCreateColumnProps<TData, TCondition>[];
```

Defined in: packages/ui/build/collection-table/internal/collection-table-state.svelte.d.ts:208

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TData` *extends* `Record`\<`string`, `unknown`\> | - |
| `TCondition` | `unknown` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cols` | [`TCreateColumnProps`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#tcreatecolumnprops)\<`TData`, `TCondition`\>[] |
| `enabled` | `boolean` |
| `t?` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

[`TCreateColumnProps`](/docs/api-reference/ui/build/collection-table/internal/collection-table-state.svelte.md#tcreatecolumnprops)\<`TData`, `TCondition`\>[]
