[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-record-metadata/collection-record-metadata

# ui/build/collection-record-metadata/collection-record-metadata

## Type Aliases

<a id="collectionrecordflagmetadata"></a>

### CollectionRecordFlagMetadata

```ts
type CollectionRecordFlagMetadata = typeof CollectionRecordFlagMetadataSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:24

***

<a id="collectionrecordflagtone"></a>

### CollectionRecordFlagTone

```ts
type CollectionRecordFlagTone = typeof CollectionRecordFlagToneSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:5

***

<a id="collectionrecordmetadata"></a>

### CollectionRecordMetadata

```ts
type CollectionRecordMetadata = typeof CollectionRecordMetadataSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:48

***

<a id="collectionrecordmetadataresolver"></a>

### CollectionRecordMetadataResolver

```ts
type CollectionRecordMetadataResolver<TRow> = (record) => readonly CollectionRecordMetadata[];
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:53

Pure, synchronous projection over an already-read row. Related facts must be batch-loaded by the
surface before this runs; a resolver is never a place to issue one query per record.

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | `TRow` |

#### Returns

readonly [`CollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#collectionrecordmetadata)[]

***

<a id="collectionrecordmetadatasource"></a>

### CollectionRecordMetadataSource

```ts
type CollectionRecordMetadataSource = typeof CollectionRecordMetadataSourceSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:55

***

<a id="collectionrecordmutation"></a>

### CollectionRecordMutation

```ts
type CollectionRecordMutation = typeof CollectionRecordMutationSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:3

***

<a id="collectionrecordrestrictionmetadata"></a>

### CollectionRecordRestrictionMetadata

```ts
type CollectionRecordRestrictionMetadata = typeof CollectionRecordRestrictionMetadataSchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:15

***

<a id="collectionrecordsystemmetadatacopy"></a>

### CollectionRecordSystemMetadataCopy

```ts
type CollectionRecordSystemMetadataCopy = typeof CollectionRecordSystemMetadataCopySchema.Type;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:63

***

<a id="resolvedcollectionrecordmetadata"></a>

### ResolvedCollectionRecordMetadata

```ts
type ResolvedCollectionRecordMetadata = CollectionRecordMetadata & object;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:56

#### Type Declaration

##### source

```ts
readonly source: CollectionRecordMetadataSource;
```

## Functions

<a id="collectionrecordmetadatadescription"></a>

### collectionRecordMetadataDescription()

```ts
function collectionRecordMetadataDescription(metadata): string;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:73

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `metadata` | [`ResolvedCollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#resolvedcollectionrecordmetadata) |

#### Returns

`string`

***

<a id="collectionrecordmutationreason"></a>

### collectionRecordMutationReason()

```ts
function collectionRecordMutationReason(metadata, operation): string | null;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:72

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `metadata` | readonly [`ResolvedCollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#resolvedcollectionrecordmetadata)[] |
| `operation` | `"update"` \| `"delete"` |

#### Returns

`string` \| `null`

***

<a id="collectionrecordrestriction"></a>

### collectionRecordRestriction()

```ts
function collectionRecordRestriction(metadata, operation): object & object | null;
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:69

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `metadata` | readonly [`ResolvedCollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#resolvedcollectionrecordmetadata)[] |
| `operation` | `"update"` \| `"delete"` |

#### Returns

`object` & `object`

***

`null`

***

<a id="resolvecollectionrecordmetadata"></a>

### resolveCollectionRecordMetadata()

```ts
function resolveCollectionRecordMetadata(
   record,
   authored,
   copy): readonly ResolvedCollectionRecordMetadata[];
```

Defined in: packages/ui/build/collection-record-metadata/collection-record-metadata.d.ts:68

Projects protected Bolt state and authored metadata into the one contract collection UIs consume.
Authored metadata never accepts a `source`, so an application cannot impersonate system state.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | `object` \| `null` \| `undefined` |
| `authored` | \| readonly ( \| \{ `kind`: `"restriction"`; `label?`: `string`; `operations`: readonly \[`"update"` \| `"delete"`, `"update"` \| `"delete"`\]; `reason`: `string`; \} \| \{ `description?`: `string`; `icon?`: `string`; `kind`: `"flag"`; `label`: `string`; `tone`: `"info"` \| `"neutral"` \| `"success"` \| `"warning"` \| `"danger"`; \})[] \| `null` \| `undefined` |
| `copy` | \{ `pendingApprovalLabel`: `string`; `pendingApprovalReason`: `string`; \} |
| `copy.pendingApprovalLabel` | `string` |
| `copy.pendingApprovalReason` | `string` |

#### Returns

readonly [`ResolvedCollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#resolvedcollectionrecordmetadata)[]
