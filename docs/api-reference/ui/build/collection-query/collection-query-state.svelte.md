[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-query/collection-query-state.svelte

# ui/build/collection-query/collection-query-state.svelte

## Classes

<a id="collectionquerystate"></a>

### CollectionQueryState

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:44

The one search + filter + pagination model a collection surface binds.

Every surface used to keep its own three pieces of state and its own rule for how they interact,
and the rule is the part that kept going wrong. Narrowing a result set invalidates the page you
are on: filter a six-page board down to one page while sitting on page four and the query asks
for rows past the end, so the surface renders empty and reads as broken. `CollectionTable` knew
this and called `resetToFirstPage()`; the roster month board knew it too and assigned
`boardPage = 0` by hand in five separate handlers, which is five chances to forget.

Here the reset is not something a caller remembers to do — `setSearch` and `setFilters` own it,
because it is a property of the model rather than of any one surface.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CollectionQueryState<TRow>(options?): CollectionQueryState<TRow>;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:46

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`CollectionQueryStateOptions`](/docs/api-reference/ui/build/collection-query/collection-query-state.svelte.md#collectionquerystateoptions)\<`TRow`\> |

###### Returns

[`CollectionQueryState`](/docs/api-reference/ui/build/collection-query/collection-query-state.svelte.md#collectionquerystate)\<`TRow`\>

#### Accessors

<a id="filters"></a>

##### filters

###### Get Signature

```ts
get filters(): readonly CollectionFilter[];
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:48

###### Returns

readonly [`CollectionFilter`](/docs/api-reference/std/build/collection.md#collectionfilter)[]

<a id="narrowed"></a>

##### narrowed

###### Get Signature

```ts
get narrowed(): boolean;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:52

True while the result set is narrowed, so a surface can offer "clear" without recomputing.

###### Returns

`boolean`

<a id="pageindex"></a>

##### pageIndex

###### Get Signature

```ts
get pageIndex(): number;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:49

###### Returns

`number`

<a id="pagesize"></a>

##### pageSize

###### Get Signature

```ts
get pageSize(): number;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:50

###### Returns

`number`

<a id="queryoptions"></a>

##### queryOptions

###### Get Signature

```ts
get queryOptions(): CollectionFilterOptions;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:64

What the generated client takes.

The wire path is a mutable `string[]`, so this copies rather than casts: the state's own
tuples stay readonly and a consumer cannot reach through the query options to mutate them.

###### Returns

[`CollectionFilterOptions`](/docs/api-reference/std/build/collection.md#collectionfilteroptions)

<a id="search"></a>

##### search

###### Get Signature

```ts
get search(): string;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:47

###### Returns

`string`

#### Methods

<a id="clear"></a>

##### clear()

```ts
clear(): void;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:57

###### Returns

`void`

<a id="setfilters"></a>

##### setFilters()

```ts
setFilters(filters): void;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:54

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | readonly [`CollectionFilter`](/docs/api-reference/std/build/collection.md#collectionfilter)[] |

###### Returns

`void`

<a id="setpageindex"></a>

##### setPageIndex()

```ts
setPageIndex(pageIndex): void;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:55

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `pageIndex` | `number` |

###### Returns

`void`

<a id="setpagesize"></a>

##### setPageSize()

```ts
setPageSize(pageSize): void;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:56

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `pageSize` | `number` |

###### Returns

`void`

<a id="setsearch"></a>

##### setSearch()

```ts
setSearch(search): void;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:53

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `search` | `string` |

###### Returns

`void`

## Interfaces

<a id="collectionquerystateoptions"></a>

### CollectionQueryStateOptions

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:15

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="filters-1"></a>

##### filters?

```ts
readonly optional filters?: readonly TypedCollectionFilter<TRow>[];
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:17

<a id="pagesize-1"></a>

##### pageSize?

```ts
readonly optional pageSize?: number;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:18

<a id="persistencekey"></a>

##### persistenceKey?

```ts
readonly optional persistenceKey?: string;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:28

View key the *page size* is remembered against.

Only the page size. How many rows you want to see at once is a preference about the surface;
the search, the filters and the page you are on are the question you asked on this visit, and
a surface that restores them answers a question nobody has asked yet. Page index in particular
cannot be restored honestly by a cursor-paged surface: the cursors are rebuilt from scratch on
mount, so a remembered "page 4" would label the first page as the fourth.

<a id="search-1"></a>

##### search?

```ts
readonly optional search?: string;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:16

***

<a id="typedcollectionfilter"></a>

### TypedCollectionFilter

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:10

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="operand"></a>

##### operand?

```ts
readonly optional operand?: unknown;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:13

<a id="operator"></a>

##### operator

```ts
readonly operator:
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

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:12

<a id="path"></a>

##### path

```ts
readonly path: CollectionFilterPath<TRow>;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:11

## Type Aliases

<a id="collectionfilterpath"></a>

### CollectionFilterPath

```ts
type CollectionFilterPath<TRow> =
  | readonly [Extract<keyof TRow, string>]
  | readonly [Extract<keyof TRow, string>, string];
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:9

A filter path checked against the row it filters.

`CollectionFilter.path` on the wire is `string[]` — nothing stops a surface from filtering on a
field the collection does not have, and nothing tells you it happened; the query simply returns
everything or nothing. One hop for a column on the row, two for a column on an expanded relation.

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

## Variables

<a id="default_collection_page_size"></a>

### DEFAULT\_COLLECTION\_PAGE\_SIZE

```ts
const DEFAULT_COLLECTION_PAGE_SIZE: 50 = 50;
```

Defined in: packages/ui/build/collection-query/collection-query-state.svelte.d.ts:30
