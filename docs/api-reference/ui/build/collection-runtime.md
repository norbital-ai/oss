[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-runtime

# ui/build/collection-runtime

## Interfaces

<a id="collectionsurface"></a>

### CollectionSurface

Defined in: packages/ui/build/collection-runtime/index.d.ts:4

#### Properties

<a id="banner"></a>

##### banner?

```ts
readonly optional banner?: string | null;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:7

Static `bolt:banner` URL declared on the collection's `+representation.svelte`, if any.

<a id="representation"></a>

##### representation?

```ts
readonly optional representation?: Component<{
}, {
}, string>;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:5

***

<a id="collectionsurfaceruntime"></a>

### CollectionSurfaceRuntime

Defined in: packages/ui/build/collection-runtime/index.d.ts:10

#### Properties

<a id="appid"></a>

##### appId

```ts
readonly appId: () => string;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:11

###### Returns

`string`

<a id="surfaces"></a>

##### surfaces

```ts
readonly surfaces: CollectionSurfaceRegistry;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:12

#### Methods

<a id="claimview"></a>

##### claimView()

```ts
claimView(view): () => void;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:13

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `view` | `string` |

###### Returns

() => `void`

## Type Aliases

<a id="collectionclientgetter"></a>

### CollectionClientGetter

```ts
type CollectionClientGetter = () => CollectionClient<ErasedCollectionRegistry>;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:3

#### Returns

[`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<[`ErasedCollectionRegistry`](/docs/api-reference/std/build/collection.md#erasedcollectionregistry)\>

***

<a id="collectionsurfaceregistry"></a>

### CollectionSurfaceRegistry

```ts
type CollectionSurfaceRegistry = Readonly<Record<string, CollectionSurface>>;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:9

## Functions

<a id="getcollectionclientcontext"></a>

### getCollectionClientContext()

```ts
function getCollectionClientContext(): CollectionClient<Readonly<Record<string, CollectionType<CollectionRecord, CollectionRecord, CollectionRecord, CollectionRecord>>>>;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:15

#### Returns

[`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\>

***

<a id="getcollectionclientforsurface"></a>

### getCollectionClientForSurface()

```ts
function getCollectionClientForSurface(candidate, surfaceName): CollectionClient<Readonly<Record<string, CollectionType<CollectionRecord, CollectionRecord, CollectionRecord, CollectionRecord>>>>;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:26

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidate` | `object` |
| `surfaceName` | `string` |

#### Returns

[`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\>

***

<a id="getcollectionrecordscope"></a>

### getCollectionRecordScope()

```ts
function getCollectionRecordScope(): (() => string | undefined) | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:45

#### Returns

(() => `string` \| `undefined`) \| `undefined`

***

<a id="getcollectionsurfaceruntime"></a>

### getCollectionSurfaceRuntime()

```ts
function getCollectionSurfaceRuntime():
  | CollectionSurfaceRuntime
  | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:30

#### Returns

  \| [`CollectionSurfaceRuntime`](/docs/api-reference/ui/build/collection-runtime.md#collectionsurfaceruntime)
  \| `undefined`

***

<a id="getoptionalcollectionclientcontext"></a>

### getOptionalCollectionClientContext()

```ts
function getOptionalCollectionClientContext():
  | CollectionClient<Readonly<Record<string, CollectionType<CollectionRecord, CollectionRecord, CollectionRecord, CollectionRecord>>>>
  | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:16

#### Returns

  \| [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\>
  \| `undefined`

***

<a id="getoptionalcollectionclientgetter"></a>

### getOptionalCollectionClientGetter()

```ts
function getOptionalCollectionClientGetter():
  | CollectionClientGetter
  | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:24

Captures the context capability without freezing the client it currently resolves.

Host projections can replace their in-memory client when asynchronously loaded rows arrive. A
record detail therefore keeps this getter and reads it inside derived state, while ordinary
callers retain `getOptionalCollectionClientContext()` as the one-shot convenience.

#### Returns

  \| [`CollectionClientGetter`](/docs/api-reference/ui/build/collection-runtime.md#collectionclientgetter)
  \| `undefined`

***

<a id="resolvecollectionclient"></a>

### resolveCollectionClient()

```ts
function resolveCollectionClient<TCollections>(candidate):
  | CollectionClient<TCollections>
  | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:25

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TCollections` *extends* `Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`, [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\> | `Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidate` | `object` |

#### Returns

  \| [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`TCollections`\>
  \| `undefined`

***

<a id="resolvecollectionsurface"></a>

### resolveCollectionSurface()

```ts
function resolveCollectionSurface(registry, collectionName):
  | CollectionSurface
  | undefined;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:28

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `registry` | \| `Readonly`\<`Record`\<`string`, [`CollectionSurface`](/docs/api-reference/ui/build/collection-runtime.md#collectionsurface)\>\> \| `undefined` |
| `collectionName` | `string` |

#### Returns

  \| [`CollectionSurface`](/docs/api-reference/ui/build/collection-runtime.md#collectionsurface)
  \| `undefined`

***

<a id="resolvecollectionviewkey"></a>

### resolveCollectionViewKey()

```ts
function resolveCollectionViewKey(
   view,
   fallback,
   recordScope): string;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:52

The persistence key a collection surface saves its view state under.

Composed rather than concatenated at each call site so the table and the board agree on the
shape, and so a nested surface inside a record detail cannot accidentally share the outer key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `view` | `string` \| `undefined` |
| `fallback` | `string` |
| `recordScope` | `string` \| `undefined` |

#### Returns

`string`

***

<a id="setcollectionclientcontext"></a>

### setCollectionClientContext()

```ts
function setCollectionClientContext(context): void;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:27

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => [`CollectionClient`](/docs/api-reference/std/build/collection.md#collectionclient)\<`Readonly`\<`Record`\<`string`, [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord), [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>\>\>\> |

#### Returns

`void`

***

<a id="setcollectionrecordscope"></a>

### setCollectionRecordScope()

```ts
function setCollectionRecordScope(scope): void;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:44

The record a detail surface is currently mounted for, as a view-persistence scope segment.

A table nested inside a `+representation.svelte` shows one record's children, so its saved
columns/filters/sort must be keyed per parent record — otherwise every employee shares one
"employments" view. Authored source used to build that key by interpolating the parent's
`id`, which is exactly the system column authored code must not reach into. The
surface that mounts the representation already knows the id, so it publishes it here and
`view` stays a readable, stable name the author chose.

A getter rather than a value: the mounting surface's active record is reactive state, and the
scope has to follow it without the consumer re-reading context.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scope` | () => `string` \| `undefined` |

#### Returns

`void`

***

<a id="setcollectionsurfaceruntime"></a>

### setCollectionSurfaceRuntime()

```ts
function setCollectionSurfaceRuntime(runtime): void;
```

Defined in: packages/ui/build/collection-runtime/index.d.ts:29

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runtime` | [`CollectionSurfaceRuntime`](/docs/api-reference/ui/build/collection-runtime.md#collectionsurfaceruntime) |

#### Returns

`void`
