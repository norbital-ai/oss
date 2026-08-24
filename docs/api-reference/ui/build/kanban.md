[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/kanban

# ui/build/kanban

## Interfaces

<a id="kanbancolumnprops"></a>

### KanbanColumnProps

Defined in: packages/ui/build/kanban/index.d.ts:61

#### Properties

<a id="cardsnippet"></a>

##### cardSnippet

```ts
cardSnippet: TCardSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:63

<a id="column"></a>

##### column

```ts
column: object;
```

Defined in: packages/ui/build/kanban/index.d.ts:62

###### \_id

```ts
readonly _id: string;
```

###### hasMore?

```ts
readonly optional hasMore?: boolean;
```

###### isFetchingNextPage?

```ts
readonly optional isFetchingNextPage?: boolean;
```

###### isLoading?

```ts
readonly optional isLoading?: boolean;
```

###### items

```ts
readonly items: readonly object[];
```

###### title

```ts
readonly title: string;
```

###### totalCount

```ts
readonly totalCount: number;
```

<a id="columnheaderactionsnippet"></a>

##### columnHeaderActionSnippet?

```ts
optional columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:72

<a id="columntitlesnippet"></a>

##### columnTitleSnippet?

```ts
optional columnTitleSnippet?: TColumnTitleSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:73

<a id="draghandleclass"></a>

##### dragHandleClass?

```ts
optional dragHandleClass?: string;
```

Defined in: packages/ui/build/kanban/index.d.ts:71

<a id="groupname"></a>

##### groupName

```ts
groupName: string;
```

Defined in: packages/ui/build/kanban/index.d.ts:68

<a id="itemheight"></a>

##### itemHeight

```ts
itemHeight: number;
```

Defined in: packages/ui/build/kanban/index.d.ts:66

<a id="mincolumnwidth"></a>

##### minColumnWidth

```ts
minColumnWidth: number;
```

Defined in: packages/ui/build/kanban/index.d.ts:67

<a id="oncardmove"></a>

##### onCardMove?

```ts
optional onCardMove?: (move) => void;
```

Defined in: packages/ui/build/kanban/index.d.ts:64

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `move` | \{ `fromColumnId`: `string`; `recordId`: `string`; `toColumnId`: `string`; `toIndex?`: `number`; \} | - |
| `move.fromColumnId` | `string` | - |
| `move.recordId` | `string` | - |
| `move.toColumnId` | `string` | - |
| `move.toIndex?` | `number` | Target index in the destination column (from Sortable `newIndex`). |

###### Returns

`void`

<a id="onloadmore"></a>

##### onLoadMore

```ts
onLoadMore: (columnId, lastVirtualIndex) => Effect<void, unknown>;
```

Defined in: packages/ui/build/kanban/index.d.ts:65

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |
| `lastVirtualIndex` | `number` |

###### Returns

`Effect`\<`void`, `unknown`\>

<a id="sortable"></a>

##### sortable

```ts
sortable: boolean;
```

Defined in: packages/ui/build/kanban/index.d.ts:69

<a id="sortwithincolumn"></a>

##### sortWithinColumn

```ts
sortWithinColumn: boolean;
```

Defined in: packages/ui/build/kanban/index.d.ts:70

***

<a id="kanbanprops"></a>

### KanbanProps

Defined in: packages/ui/build/kanban/index.d.ts:47

#### Properties

<a id="cardsnippet-1"></a>

##### cardSnippet

```ts
cardSnippet: TCardSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:50

<a id="columnheaderactionsnippet-1"></a>

##### columnHeaderActionSnippet?

```ts
optional columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:58

<a id="columntitlesnippet-1"></a>

##### columnTitleSnippet?

```ts
optional columnTitleSnippet?: TColumnTitleSnippet;
```

Defined in: packages/ui/build/kanban/index.d.ts:59

<a id="draghandleclass-1"></a>

##### dragHandleClass?

```ts
optional dragHandleClass?: string;
```

Defined in: packages/ui/build/kanban/index.d.ts:57

<a id="groupname-1"></a>

##### groupName?

```ts
optional groupName?: string;
```

Defined in: packages/ui/build/kanban/index.d.ts:54

<a id="itemheight-1"></a>

##### itemHeight

```ts
itemHeight: number;
```

Defined in: packages/ui/build/kanban/index.d.ts:52

<a id="mincolumnwidth-1"></a>

##### minColumnWidth?

```ts
optional minColumnWidth?: number;
```

Defined in: packages/ui/build/kanban/index.d.ts:53

<a id="oncardmove-1"></a>

##### onCardMove?

```ts
optional onCardMove?: (move) => void;
```

Defined in: packages/ui/build/kanban/index.d.ts:49

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `move` | \{ `fromColumnId`: `string`; `recordId`: `string`; `toColumnId`: `string`; `toIndex?`: `number`; \} | - |
| `move.fromColumnId` | `string` | - |
| `move.recordId` | `string` | - |
| `move.toColumnId` | `string` | - |
| `move.toIndex?` | `number` | Target index in the destination column (from Sortable `newIndex`). |

###### Returns

`void`

<a id="onloadmore-1"></a>

##### onLoadMore

```ts
onLoadMore: (columnId, lastVirtualIndex) => Effect<void, unknown>;
```

Defined in: packages/ui/build/kanban/index.d.ts:51

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `columnId` | `string` |
| `lastVirtualIndex` | `number` |

###### Returns

`Effect`\<`void`, `unknown`\>

<a id="sortable-1"></a>

##### sortable?

```ts
optional sortable?: boolean;
```

Defined in: packages/ui/build/kanban/index.d.ts:55

<a id="sortwithincolumn-1"></a>

##### sortWithinColumn?

```ts
optional sortWithinColumn?: boolean;
```

Defined in: packages/ui/build/kanban/index.d.ts:56

<a id="value"></a>

##### value

```ts
value: object[];
```

Defined in: packages/ui/build/kanban/index.d.ts:48

###### \_id

```ts
readonly _id: string;
```

###### hasMore?

```ts
readonly optional hasMore?: boolean;
```

###### isFetchingNextPage?

```ts
readonly optional isFetchingNextPage?: boolean;
```

###### isLoading?

```ts
readonly optional isLoading?: boolean;
```

###### items

```ts
readonly items: readonly object[];
```

###### title

```ts
readonly title: string;
```

###### totalCount

```ts
readonly totalCount: number;
```

## Type Aliases

<a id="kanbancardmove"></a>

### KanbanCardMove

```ts
type KanbanCardMove = typeof KanbanCardMoveSchema.Type;
```

Defined in: packages/ui/build/kanban/index.d.ts:46

***

<a id="tcardsnippet"></a>

### TCardSnippet

```ts
type TCardSnippet = Snippet<[TKanbanItem & object]>;
```

Defined in: packages/ui/build/kanban/index.d.ts:26

***

<a id="tcolumnheaderactionsnippet"></a>

### TColumnHeaderActionSnippet

```ts
type TColumnHeaderActionSnippet = Snippet<[{
  columnId: string;
}]>;
```

Defined in: packages/ui/build/kanban/index.d.ts:29

***

<a id="tcolumntitlesnippet"></a>

### TColumnTitleSnippet

```ts
type TColumnTitleSnippet = Snippet<[{
  column: TKanbanColumnData;
  columnId: string;
  title: string;
}]>;
```

Defined in: packages/ui/build/kanban/index.d.ts:32

***

<a id="tkanbancarddata"></a>

### TKanbanCardData

```ts
type TKanbanCardData = TKanbanItem & object;
```

Defined in: packages/ui/build/kanban/index.d.ts:21

#### Type Declaration

##### description?

```ts
optional description?: string;
```

##### title

```ts
title: string;
```

##### type

```ts
type: "card";
```

***

<a id="tkanbancolumndata"></a>

### TKanbanColumnData

```ts
type TKanbanColumnData = typeof TKanbanColumnDataSchema.Type;
```

Defined in: packages/ui/build/kanban/index.d.ts:20

***

<a id="tkanbanitem"></a>

### TKanbanItem

```ts
type TKanbanItem = typeof TKanbanItemSchema.Type;
```

Defined in: packages/ui/build/kanban/index.d.ts:7

## Variables

<a id="default"></a>

### default

```ts
const default: object;
```

Defined in: packages/ui/build/kanban/index.d.ts:78

#### Type Declaration

<a id="column-1"></a>

##### Column

```ts
readonly Column: Component;
```

<a id="provider"></a>

##### Provider

```ts
readonly Provider: Component;
```

***

<a id="kanbancardmoveschema"></a>

### KanbanCardMoveSchema

```ts
const KanbanCardMoveSchema: Schema.Struct<{
  fromColumnId: Schema.String;
  recordId: Schema.String;
  toColumnId: Schema.String;
  toIndex: Schema.optional<Schema.Number>;
}>;
```

Defined in: packages/ui/build/kanban/index.d.ts:39

***

<a id="tkanbancolumndataschema"></a>

### TKanbanColumnDataSchema

```ts
const TKanbanColumnDataSchema: Schema.Struct<{
  _id: Schema.String;
  hasMore: Schema.optional<Schema.Boolean>;
  isFetchingNextPage: Schema.optional<Schema.Boolean>;
  isLoading: Schema.optional<Schema.Boolean>;
  items: Schema.$Array<Schema.Struct<{
     _id: Schema.String;
     type: Schema.Literals<readonly ["card", "column"]>;
  }>>;
  title: Schema.String;
  totalCount: Schema.Number;
}>;
```

Defined in: packages/ui/build/kanban/index.d.ts:8

***

<a id="tkanbanitemschema"></a>

### TKanbanItemSchema

```ts
const TKanbanItemSchema: Schema.Struct<{
  _id: Schema.String;
  type: Schema.Literals<readonly ["card", "column"]>;
}>;
```

Defined in: packages/ui/build/kanban/index.d.ts:3
