[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-kanban/collection-kanban.types

# ui/build/collection-kanban/collection-kanban.types

## Interfaces

<a id="collectionkanbanmove"></a>

### CollectionKanbanMove

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:8

#### Type Parameters

| Type Parameter |
| ------ |
| `Row` |

#### Properties

<a id="fromlane"></a>

##### fromLane

```ts
fromLane: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:10

<a id="record"></a>

##### record

```ts
record: Row;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:9

<a id="tolane"></a>

##### toLane

```ts
toLane: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:11

***

<a id="collectionkanbanprops"></a>

### CollectionKanbanProps

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:13

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
| `TName` *extends* [`CollectionKanbanName`](/docs/api-reference/ui/build/collection-kanban/collection-kanban.types.md#collectionkanbanname)\<`TCollections`\> |

#### Properties

<a id="card"></a>

##### Card?

```ts
optional Card?: Snippet<[CollectionRow<TCollections[TName]>]>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:31

Card override. Omit to auto-derive the card from field structure (RFC V.3).

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:37

<a id="client"></a>

##### client

```ts
client: CollectionDbClient<TCollections>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:14

<a id="collection"></a>

##### collection

```ts
collection: TName;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:15

<a id="description"></a>

##### description?

```ts
optional description?: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:26

<a id="exportpipelines"></a>

##### exportPipelines?

```ts
optional exportPipelines?: readonly CollectionTablePipeline<CollectionRow<TCollections[TName]>>[];
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:27

<a id="groupby"></a>

##### groupBy

```ts
groupBy: Extract<keyof CollectionRow<TCollections[TName]>>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:17

<a id="importpipelines"></a>

##### importPipelines?

```ts
optional importPipelines?: readonly CollectionTablePipeline<CollectionRow<TCollections[TName]>>[];
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:28

<a id="integrations"></a>

##### integrations?

```ts
optional integrations?: readonly object[];
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:29

<a id="lanes"></a>

##### lanes?

```ts
optional lanes?: readonly AuthoredLaneInput[];
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:19

Lane subset pick/order with optional labels/colours. Omit to derive from the groupBy field (RFC V.3).

<a id="oncardmove"></a>

##### onCardMove?

```ts
optional onCardMove?: (move) => Effect<void, unknown>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:36

Move handler. Omit for the default optimistic move that writes `toLane` into the groupBy
field with rollback on failure (RFC V.3c).

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `move` | [`CollectionKanbanMove`](/docs/api-reference/ui/build/collection-kanban/collection-kanban.types.md#collectionkanbanmove)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollections`\[`TName`\]\>\> |

###### Returns

`Effect`\<`void`, `unknown`\>

<a id="query"></a>

##### query?

```ts
optional query?: CollectionQuery<CollectionRow<TCollections[TName]>>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:22

<a id="recordmetadata"></a>

##### recordMetadata?

```ts
optional recordMetadata?: CollectionRecordMetadataResolver<CollectionRow<TCollections[TName]>>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:23

<a id="rows"></a>

##### rows?

```ts
optional rows?: number;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:21

Number of visual lane rows. Defaults to one horizontal row.

<a id="selectable"></a>

##### selectable?

```ts
optional selectable?: boolean;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:24

<a id="title"></a>

##### title?

```ts
optional title?: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:25

<a id="view"></a>

##### view?

```ts
optional view?: string;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:16

## Type Aliases

<a id="collectionkanbanname"></a>

### CollectionKanbanName

```ts
type CollectionKanbanName<TCollections> = Extract<keyof TCollections, string>;
```

Defined in: packages/ui/build/collection-kanban/collection-kanban.types.d.ts:7

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
