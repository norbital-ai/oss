[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table-navigation.svelte

# ui/build/collection-table/collection-table-navigation.svelte

## Classes

<a id="collectiontableurlnavigation"></a>

### CollectionTableUrlNavigation

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:34

#### Implements

- [`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation)

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CollectionTableUrlNavigation(params): CollectionTableUrlNavigation;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:36

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | \{ `getUrl`: () => `URL`; `navigate`: (`href`) => `void`; \} |
| `params.getUrl` | () => `URL` |
| `params.navigate` | (`href`) => `void` |

###### Returns

[`CollectionTableUrlNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontableurlnavigation)

#### Accessors

<a id="current"></a>

##### current

###### Get Signature

```ts
get current():
  | {
  collectionName: string;
  parentRouteKey?: string;
  recordId: string;
  routeKey: string;
}
  | null;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:40

###### Returns

  \| \{
  `collectionName`: `string`;
  `parentRouteKey?`: `string`;
  `recordId`: `string`;
  `routeKey`: `string`;
\}
  \| `null`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`current`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#current-1)

<a id="targets"></a>

##### targets

###### Get Signature

```ts
get targets(): object[];
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:49

Every frame of the URL stack, shallowest first.

A detail registration only exists while the table that owns it is mounted, and a nested
table is mounted by its parent frame's detail surface. Rendering only the deepest frame
therefore unmounts the very table the deepest frame needs, so the surface renders the
whole chain and keeps each ancestor alive.

###### Returns

`object`[]

#### Methods

<a id="detailclient"></a>

##### detailClient()

```ts
detailClient(routeKey, collectionName?):
  | CollectionClient<Readonly<Record<string, CollectionType<CollectionRecord, CollectionRecord, CollectionRecord, CollectionRecord>>>>
  | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:75

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `routeKey` | `string` |
| `collectionName?` | `string` |

###### Returns

  \| [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\>
  \| `undefined`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`detailClient`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#detailclient-1)

<a id="href"></a>

##### href()

```ts
href(target): string;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:55

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `recordId`: `string`; `routeKey`: `string`; \} |
| `target.collectionName` | `string` |
| `target.parentRouteKey?` | `string` |
| `target.recordId` | `string` |
| `target.routeKey` | `string` |

###### Returns

`string`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`href`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#href-1)

<a id="open"></a>

##### open()

```ts
open(target): void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:56

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `recordId`: `string`; `routeKey`: `string`; \} |
| `target.collectionName` | `string` |
| `target.parentRouteKey?` | `string` |
| `target.recordId` | `string` |
| `target.routeKey` | `string` |

###### Returns

`void`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`open`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#open-1)

<a id="pop"></a>

##### pop()

```ts
pop(): void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:78

###### Returns

`void`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`pop`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#pop-1)

<a id="popto"></a>

##### popTo()

```ts
popTo(depth): void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:77

Close the frame at `depth`, keeping every shallower frame open.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `depth` | `number` |

###### Returns

`void`

<a id="registercollectionclient"></a>

##### registerCollectionClient()

```ts
registerCollectionClient(collectionName, client): () => void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:74

Registers one explicitly named host projection independently of any mounted table.

This is deliberately collection-by-collection rather than registering every definition on a
client: People may own its three host-only projections, but cannot accidentally capture an
unrelated tenant collection with the same navigation surface.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `client` | () => [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\> |

###### Returns

() => `void`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`registerCollectionClient`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#registercollectionclient-1)

<a id="registerdetailclient"></a>

##### registerDetailClient()

```ts
registerDetailClient(routeKey, client): () => void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:66

Makes a table's own client available to the sibling detail frame that its URL opens.

Most tables use the workspace client already published above the navigation surface. Host
projections such as People are deliberately different: their rows live in a read-only local
client and have no tenant collection to dispatch. The route key identifies the table that
opened the frame, so the sheet can read through that exact capability without teaching the
runtime about a host-only pseudo-collection.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `routeKey` | `string` |
| `client` | [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\> |

###### Returns

() => `void`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`registerDetailClient`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#registerdetailclient-1)

<a id="resolverecordid"></a>

##### resolveRecordId()

```ts
resolveRecordId(params): string | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:50

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `routeKey`: `string`; \} |
| `params.collectionName` | `string` |
| `params.parentRouteKey?` | `string` |
| `params.routeKey` | `string` |

###### Returns

`string` \| `undefined`

###### Implementation of

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation).[`resolveRecordId`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#resolverecordid-1)

## Interfaces

<a id="collectiontablenavigation"></a>

### CollectionTableNavigation

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:10

#### Properties

<a id="current-1"></a>

##### current

```ts
readonly current:
  | {
  collectionName: string;
  parentRouteKey?: string;
  recordId: string;
  routeKey: string;
}
  | null;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:11

#### Methods

<a id="detailclient-1"></a>

##### detailClient()

```ts
detailClient(routeKey, collectionName?):
  | CollectionClient<Readonly<Record<string, CollectionType<CollectionRecord, CollectionRecord, CollectionRecord, CollectionRecord>>>>
  | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:22

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `routeKey` | `string` |
| `collectionName?` | `string` |

###### Returns

  \| [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\>
  \| `undefined`

<a id="href-1"></a>

##### href()

```ts
href(target): string;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:17

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `recordId`: `string`; `routeKey`: `string`; \} |
| `target.collectionName` | `string` |
| `target.parentRouteKey?` | `string` |
| `target.recordId` | `string` |
| `target.routeKey` | `string` |

###### Returns

`string`

<a id="open-1"></a>

##### open()

```ts
open(target): void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:18

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `recordId`: `string`; `routeKey`: `string`; \} |
| `target.collectionName` | `string` |
| `target.parentRouteKey?` | `string` |
| `target.recordId` | `string` |
| `target.routeKey` | `string` |

###### Returns

`void`

<a id="pop-1"></a>

##### pop()

```ts
pop(): void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:19

###### Returns

`void`

<a id="registercollectionclient-1"></a>

##### registerCollectionClient()

```ts
registerCollectionClient(collectionName, client): () => void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:21

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `client` | () => [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\> |

###### Returns

() => `void`

<a id="registerdetailclient-1"></a>

##### registerDetailClient()

```ts
registerDetailClient(routeKey, client): () => void;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:20

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `routeKey` | `string` |
| `client` | [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\> |

###### Returns

() => `void`

<a id="resolverecordid-1"></a>

##### resolveRecordId()

```ts
resolveRecordId(params): string | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:12

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `routeKey`: `string`; \} |
| `params.collectionName` | `string` |
| `params.parentRouteKey?` | `string` |
| `params.routeKey` | `string` |

###### Returns

`string` \| `undefined`

## Type Aliases

<a id="collectiontablenavigationtarget"></a>

### CollectionTableNavigationTarget

```ts
type CollectionTableNavigationTarget = typeof collectionTableNavigationTargetSchema.Type;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:9

## Functions

<a id="createcollectiontableroutekey"></a>

### createCollectionTableRouteKey()

```ts
function createCollectionTableRouteKey(params): string;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:31

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | \{ `view`: `string`; \} |
| `params.view` | `string` |

#### Returns

`string`

***

<a id="getcollectiontablenavigationcontext"></a>

### getCollectionTableNavigationContext()

```ts
function getCollectionTableNavigationContext():
  | CollectionTableNavigation
  | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:25

#### Returns

  \| [`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation)
  \| `undefined`

***

<a id="resolvecollectiontablerecordid"></a>

### resolveCollectionTableRecordId()

```ts
function resolveCollectionTableRecordId(targets, params): string | undefined;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:26

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `targets` | \| \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `recordId`: `string`; `routeKey`: `string`; \} \| readonly `object`[] \| `null` \| `undefined` |
| `params` | \{ `collectionName`: `string`; `parentRouteKey?`: `string`; `routeKey`: `string`; \} |
| `params.collectionName` | `string` |
| `params.parentRouteKey?` | `string` |
| `params.routeKey` | `string` |

#### Returns

`string` \| `undefined`

***

<a id="setcollectiontablenavigationcontext"></a>

### setCollectionTableNavigationContext()

```ts
function setCollectionTableNavigationContext(navigation): CollectionTableNavigation;
```

Defined in: packages/ui/build/collection-table/collection-table-navigation.svelte.d.ts:24

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `navigation` | [`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation) |

#### Returns

[`CollectionTableNavigation`](/docs/api-reference/ui/build/collection-table/collection-table-navigation.svelte.md#collectiontablenavigation)
