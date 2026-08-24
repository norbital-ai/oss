[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/data-grid.svelte

# ui/build/collection-table/data-grid.svelte

## Interfaces

<a id="datagridcellcontext"></a>

### DataGridCellContext

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:2

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="row"></a>

##### row

```ts
readonly row: TRow;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:3

<a id="value"></a>

##### value

```ts
readonly value: unknown;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:4

***

<a id="datagridcolumn"></a>

### DataGridColumn

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:6

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="hideable"></a>

##### hideable?

```ts
readonly optional hideable?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:14

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:7

<a id="label"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:8

<a id="maxwidth"></a>

##### maxWidth?

```ts
readonly optional maxWidth?: number;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:11

<a id="minwidth"></a>

##### minWidth?

```ts
readonly optional minWidth?: number;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:10

<a id="pinnable"></a>

##### pinnable?

```ts
readonly optional pinnable?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:15

<a id="render"></a>

##### render?

```ts
readonly optional render?: (context) => unknown;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:17

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`DataGridCellContext`](/docs/api-reference/ui/build/collection-table/data-grid.svelte.md#datagridcellcontext)\<`TRow`\> |

###### Returns

`unknown`

<a id="resizable"></a>

##### resizable?

```ts
readonly optional resizable?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:13

<a id="sortable"></a>

##### sortable?

```ts
readonly optional sortable?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:12

<a id="value-1"></a>

##### value?

```ts
readonly optional value?: (row) => unknown;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:16

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `TRow` |

###### Returns

`unknown`

<a id="width"></a>

##### width?

```ts
readonly optional width?: number;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:9

***

<a id="datagridprops"></a>

### DataGridProps

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:19

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="bounded"></a>

##### bounded?

```ts
readonly optional bounded?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:28

<a id="class"></a>

##### class?

```ts
readonly optional class?: string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:27

<a id="columns"></a>

##### columns

```ts
readonly columns: readonly DataGridColumn<TRow>[];
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:22

<a id="details"></a>

##### details?

```ts
readonly optional details?: Snippet<[TRow]>;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:30

<a id="disabled"></a>

##### disabled?

```ts
readonly optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:26

<a id="emptyplaceholder"></a>

##### emptyPlaceholder?

```ts
readonly optional emptyPlaceholder?: Snippet<[]>;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:29

<a id="error"></a>

##### error?

```ts
readonly optional error?: string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:25

<a id="expandedrowids"></a>

##### expandedRowIds?

```ts
optional expandedRowIds?: string[];
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:33

Controlled disclosure state. Bind this above refreshable data to survive grid remounts.

<a id="hasdetails"></a>

##### hasDetails?

```ts
readonly optional hasDetails?: (row) => boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:31

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `TRow` |

###### Returns

`boolean`

<a id="loading"></a>

##### loading?

```ts
readonly optional loading?: boolean;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:24

<a id="onexpandedrowidschange"></a>

##### onExpandedRowIdsChange?

```ts
readonly optional onExpandedRowIdsChange?: (rowIds) => void;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:34

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `rowIds` | `string`[] |

###### Returns

`void`

<a id="rowid"></a>

##### rowId

```ts
readonly rowId: (row) => string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:21

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `TRow` |

###### Returns

`string`

<a id="rows"></a>

##### rows

```ts
readonly rows: readonly TRow[];
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:20

<a id="view"></a>

##### view

```ts
readonly view: string;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:23

## Type Aliases

<a id="default"></a>

### default

```ts
type default<TRow> = InstanceType<typeof default>;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:57

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

## Variables

<a id="default-1"></a>

### default

```ts
const default: $$IsomorphicComponent;
```

Defined in: packages/ui/build/collection-table/data-grid.svelte.d.ts:57
