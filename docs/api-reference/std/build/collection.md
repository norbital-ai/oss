[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/collection

# std/build/collection

## Interfaces

<a id="collectionapprovaloperations"></a>

### CollectionApprovalOperations

Defined in: packages/std/build/collection/index.d.ts:204

#### Properties

<a id="findmany"></a>

##### findMany

```ts
readonly findMany: (approvalRequestId) => RemoteQuery<readonly CollectionApprovalRequest[]>;
```

Defined in: packages/std/build/collection/index.d.ts:205

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `approvalRequestId` | `string` |

###### Returns

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<readonly [`CollectionApprovalRequest`](/docs/api-reference/std/build/collection.md#collectionapprovalrequest)[]\>

<a id="process"></a>

##### process

```ts
readonly process: (input) => Promise<void>;
```

Defined in: packages/std/build/collection/index.d.ts:206

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | \{ `action`: `"APPROVED"` \| `"REJECTED"` \| `"REQUEST_FOR_CHANGE"` \| `"SUPERSEDED"`; `approvalRequestId`: `string`; `comments?`: `string`; \} |
| `input.action` | `"APPROVED"` \| `"REJECTED"` \| `"REQUEST_FOR_CHANGE"` \| `"SUPERSEDED"` |
| `input.approvalRequestId` | `string` |
| `input.comments?` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="withdraw"></a>

##### withdraw

```ts
readonly withdraw: (approvalRequestId) => Promise<void>;
```

Defined in: packages/std/build/collection/index.d.ts:211

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `approvalRequestId` | `string` |

###### Returns

`Promise`\<`void`\>

***

<a id="collectionapprovalrequest"></a>

### CollectionApprovalRequest

Defined in: packages/std/build/collection/index.d.ts:194

#### Properties

<a id="candecide"></a>

##### canDecide

```ts
readonly canDecide: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:198

Whether this principal may decide the request's current step.

<a id="cansupersede"></a>

##### canSupersede

```ts
readonly canSupersede: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:200

Whether this principal may explicitly finish every remaining step.

<a id="canwithdraw"></a>

##### canWithdraw

```ts
readonly canWithdraw: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:202

Whether this principal is the requestor and may withdraw the open request.

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/std/build/collection/index.d.ts:195

<a id="status"></a>

##### status

```ts
readonly status: string;
```

Defined in: packages/std/build/collection/index.d.ts:196

***

<a id="collectionbasequery"></a>

### CollectionBaseQuery

Defined in: packages/std/build/collection/index.d.ts:119

#### Extended by

- [`CollectionQuery`](/docs/api-reference/std/build/collection.md#collectionquery)
- [`CollectionGroupedQuery`](/docs/api-reference/std/build/collection.md#collectiongroupedquery)

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="bypass_secret"></a>

##### bypass\_secret?

```ts
readonly optional bypass_secret?: string;
```

Defined in: packages/std/build/collection/index.d.ts:126

<a id="columns"></a>

##### columns?

```ts
readonly optional columns?: Record<string, boolean>;
```

Defined in: packages/std/build/collection/index.d.ts:124

<a id="orderby"></a>

##### orderBy?

```ts
readonly optional orderBy?: Partial<Record<Extract<keyof TRow, string>, "asc" | "desc">>;
```

Defined in: packages/std/build/collection/index.d.ts:125

<a id="search"></a>

##### search?

```ts
readonly optional search?: string;
```

Defined in: packages/std/build/collection/index.d.ts:123

Typo-tolerant search across text/phone/enum fields and direct relationship text labels.

<a id="where"></a>

##### where?

```ts
readonly optional where?: Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:121

<a id="with"></a>

##### with?

```ts
readonly optional with?: Record<string, unknown>;
```

Defined in: packages/std/build/collection/index.d.ts:120

***

<a id="collectionclient"></a>

### CollectionClient

Defined in: packages/std/build/collection/index.d.ts:227

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |

#### Properties

<a id="collectionregistrytype"></a>

##### \[collectionRegistryType\]?

```ts
readonly optional [collectionRegistryType]?: TCollections;
```

Defined in: packages/std/build/collection/index.d.ts:228

<a id="approvals"></a>

##### approvals?

```ts
readonly optional approvals?: CollectionApprovalOperations;
```

Defined in: packages/std/build/collection/index.d.ts:237

<a id="collections"></a>

##### collections

```ts
readonly collections: { readonly [TName in string | number | symbol]: CollectionDefinition<TCollections[TName]> };
```

Defined in: packages/std/build/collection/index.d.ts:232

<a id="db"></a>

##### db

```ts
readonly db: { readonly [TName in string | number | symbol]: CollectionOperations<TCollections[TName]> };
```

Defined in: packages/std/build/collection/index.d.ts:229

<a id="history"></a>

##### history?

```ts
readonly optional history?: CollectionHistoryOperations;
```

Defined in: packages/std/build/collection/index.d.ts:236

<a id="records"></a>

##### records

```ts
readonly records: CollectionRecordOperations;
```

Defined in: packages/std/build/collection/index.d.ts:235

***

<a id="collectiondbclient"></a>

### CollectionDbClient

Defined in: packages/std/build/collection/index.d.ts:240

Tenant-authored collection surfaces receive only the typed database vocabulary.

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |

#### Properties

<a id="collectionregistrytype-1"></a>

##### \[collectionRegistryType\]?

```ts
readonly optional [collectionRegistryType]?: TCollections;
```

Defined in: packages/std/build/collection/index.d.ts:241

<a id="db-1"></a>

##### db

```ts
readonly db: { readonly [TName in string | number | symbol]: CollectionOperations<TCollections[TName]> };
```

Defined in: packages/std/build/collection/index.d.ts:242

***

<a id="collectiondefinition"></a>

### CollectionDefinition

Defined in: packages/std/build/collection/index.d.ts:111

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> | [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype) |

#### Properties

<a id="fields"></a>

##### fields

```ts
readonly fields: readonly CollectionField<Extract<keyof CollectionRow<TCollection>, string>>[];
```

Defined in: packages/std/build/collection/index.d.ts:115

<a id="name"></a>

##### name

```ts
readonly name: string;
```

Defined in: packages/std/build/collection/index.d.ts:112

<a id="recordlabel"></a>

##### recordLabel?

```ts
readonly optional recordLabel?: string | null;
```

Defined in: packages/std/build/collection/index.d.ts:113

<a id="relationships"></a>

##### relationships?

```ts
readonly optional relationships?: readonly CollectionRelationship[];
```

Defined in: packages/std/build/collection/index.d.ts:116

<a id="system"></a>

##### system?

```ts
readonly optional system?: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:114

***

<a id="collectionfield"></a>

### CollectionField

Defined in: packages/std/build/collection/index.d.ts:61

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TName` *extends* `string` | `string` |

#### Properties

<a id="array"></a>

##### array?

```ts
readonly optional array?: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:66

<a id="currencies"></a>

##### currencies?

```ts
readonly optional currencies?: readonly string[];
```

Defined in: packages/std/build/collection/index.d.ts:72

<a id="kind"></a>

##### kind

```ts
readonly kind: string;
```

Defined in: packages/std/build/collection/index.d.ts:63

<a id="label"></a>

##### label?

```ts
readonly optional label?: string;
```

Defined in: packages/std/build/collection/index.d.ts:65

<a id="mimetypes"></a>

##### mimeTypes?

```ts
readonly optional mimeTypes?: readonly string[];
```

Defined in: packages/std/build/collection/index.d.ts:73

<a id="name-1"></a>

##### name

```ts
readonly name: TName;
```

Defined in: packages/std/build/collection/index.d.ts:62

<a id="nullable"></a>

##### nullable

```ts
readonly nullable: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:64

<a id="options"></a>

##### options?

```ts
readonly optional options?: Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:71

<a id="precision"></a>

##### precision?

```ts
readonly optional precision?: "day" | "minute";
```

Defined in: packages/std/build/collection/index.d.ts:70

How precisely an instant range is picked: calendar days, or date-times.

<a id="readonly"></a>

##### readOnly?

```ts
readonly optional readOnly?: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:67

<a id="relation"></a>

##### relation?

```ts
readonly optional relation?: object;
```

Defined in: packages/std/build/collection/index.d.ts:88

Carries no label: how a related record reads is a view decision, declared where the relation
is rendered (a table column's `relation.label`), not inherited from the target collection.

###### name

```ts
readonly name: string;
```

###### target

```ts
readonly target: string;
```

<a id="search-1"></a>

##### search?

```ts
readonly optional search?: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:83

Explicit search opt-in, authored as `text({ search: true })`.

Search is opt-in: only a non-array text/phone/enum field carrying `search: true` gets a
trigram search index and participates in any search path — the collection search box, the
omni finder and @ mentions, relation pickers. Absent means the field is never searched and
never indexed, however text-like its kind.

<a id="values"></a>

##### values?

```ts
readonly optional values?: readonly string[];
```

Defined in: packages/std/build/collection/index.d.ts:68

<a id="variant"></a>

##### variant?

```ts
readonly optional variant?: NumericRendererVariant;
```

Defined in: packages/std/build/collection/index.d.ts:74

***

<a id="collectionfilter"></a>

### CollectionFilter

Defined in: packages/std/build/collection/index.d.ts:175

One filter condition as the wire carries it.

Stated structurally, because the schema needs a transport and the vocabulary does not — a table
rendering filter chips has no business importing a wire validator to learn what a filter is.

`operator` stays an inline union rather than an exported alias: the filter builder already
extends it as `CollectionFilter['operator'] | 'contains'`, and a second exported name for the
same set is how the two drift.

#### Properties

<a id="operand"></a>

##### operand?

```ts
readonly optional operand?: unknown;
```

Defined in: packages/std/build/collection/index.d.ts:180

Omitted for the operators that take none (`isNull`, `isNotNull`).

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

Defined in: packages/std/build/collection/index.d.ts:178

<a id="path"></a>

##### path

```ts
readonly path: readonly string[];
```

Defined in: packages/std/build/collection/index.d.ts:177

One or two segments: `status`, or `agreement_employment.employee_number` split in two.

***

<a id="collectionfilteroptions"></a>

### CollectionFilterOptions

Defined in: packages/std/build/collection/index.d.ts:182

#### Properties

<a id="filters"></a>

##### filters?

```ts
readonly optional filters?: readonly CollectionFilter[];
```

Defined in: packages/std/build/collection/index.d.ts:183

***

<a id="collectiongroupedquery"></a>

### CollectionGroupedQuery

Defined in: packages/std/build/collection/index.d.ts:133

#### Extends

- [`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery)\<`TRow`\>

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="bypass_secret-1"></a>

##### bypass\_secret?

```ts
readonly optional bypass_secret?: string;
```

Defined in: packages/std/build/collection/index.d.ts:126

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`bypass_secret`](/docs/api-reference/std/build/collection.md#bypass_secret)

<a id="columns-1"></a>

##### columns?

```ts
readonly optional columns?: Record<string, boolean>;
```

Defined in: packages/std/build/collection/index.d.ts:124

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`columns`](/docs/api-reference/std/build/collection.md#columns)

<a id="group"></a>

##### group

```ts
readonly group: object;
```

Defined in: packages/std/build/collection/index.d.ts:135

###### by

```ts
readonly by: Extract<keyof TRow, string>;
```

###### lanes?

```ts
readonly optional lanes?: unknown[];
```

<a id="limit"></a>

##### limit?

```ts
readonly optional limit?: number;
```

Defined in: packages/std/build/collection/index.d.ts:134

<a id="orderby-1"></a>

##### orderBy?

```ts
readonly optional orderBy?: Partial<Record<Extract<keyof TRow, string>, "asc" | "desc">>;
```

Defined in: packages/std/build/collection/index.d.ts:125

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`orderBy`](/docs/api-reference/std/build/collection.md#orderby)

<a id="search-2"></a>

##### search?

```ts
readonly optional search?: string;
```

Defined in: packages/std/build/collection/index.d.ts:123

Typo-tolerant search across text/phone/enum fields and direct relationship text labels.

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`search`](/docs/api-reference/std/build/collection.md#search)

<a id="where-1"></a>

##### where?

```ts
readonly optional where?: Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:121

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`where`](/docs/api-reference/std/build/collection.md#where)

<a id="with-1"></a>

##### with?

```ts
readonly optional with?: Record<string, unknown>;
```

Defined in: packages/std/build/collection/index.d.ts:120

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`with`](/docs/api-reference/std/build/collection.md#with)

***

<a id="collectionhistoryoperations"></a>

### CollectionHistoryOperations

Defined in: packages/std/build/collection/index.d.ts:222

#### Methods

<a id="findmany-1"></a>

##### findMany()

```ts
findMany(
   collectionName,
   recordId,
limit?): RemoteQuery<readonly CollectionRecordHistoryEntry[]>;
```

Defined in: packages/std/build/collection/index.d.ts:223

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `recordId` | `string` |
| `limit?` | `number` |

###### Returns

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<readonly [`CollectionRecordHistoryEntry`](/docs/api-reference/std/build/collection.md#collectionrecordhistoryentry)[]\>

***

<a id="collectionoperations"></a>

### CollectionOperations

Defined in: packages/std/build/collection/index.d.ts:185

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

#### Properties

<a id="count"></a>

##### count

```ts
readonly count: (query?, options?) => RemoteQuery<number>;
```

Defined in: packages/std/build/collection/index.d.ts:189

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query?` | [`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>\> |
| `options?` | [`CollectionFilterOptions`](/docs/api-reference/std/build/collection.md#collectionfilteroptions) |

###### Returns

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<`number`\>

<a id="findfirst"></a>

##### findFirst

```ts
readonly findFirst: (query?) => RemoteQuery<
  | CollectionRow<TCollection>
| undefined>;
```

Defined in: packages/std/build/collection/index.d.ts:187

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query?` | [`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>\> |

###### Returns

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<
  \| [`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>
  \| `undefined`\>

<a id="findgrouped"></a>

##### findGrouped

```ts
readonly findGrouped: (query, options?) => RemoteQuery<Readonly<Record<string, CollectionRow<TCollection>[]>>>;
```

Defined in: packages/std/build/collection/index.d.ts:188

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query` | [`CollectionGroupedQuery`](/docs/api-reference/std/build/collection.md#collectiongroupedquery)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>\> |
| `options?` | [`CollectionFilterOptions`](/docs/api-reference/std/build/collection.md#collectionfilteroptions) |

###### Returns

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<`Readonly`\<`Record`\<`string`, [`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>[]\>\>\>

<a id="findmany-2"></a>

##### findMany

```ts
readonly findMany: (query?, options?) => CollectionPageQuery<CollectionRow<TCollection>>;
```

Defined in: packages/std/build/collection/index.d.ts:186

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query?` | [`CollectionQuery`](/docs/api-reference/std/build/collection.md#collectionquery)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>\> |
| `options?` | [`CollectionFilterOptions`](/docs/api-reference/std/build/collection.md#collectionfilteroptions) |

###### Returns

[`CollectionPageQuery`](/docs/api-reference/std/build/collection.md#collectionpagequery)\<[`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollection`\>\>

<a id="mutate"></a>

##### mutate

```ts
readonly mutate: (values) => Promise<void>;
```

Defined in: packages/std/build/collection/index.d.ts:190

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | [`CollectionMutationInput`](/docs/api-reference/std/build/collection.md#collectionmutationinput)\<`TCollection`\> |

###### Returns

`Promise`\<`void`\>

<a id="pending"></a>

##### pending

```ts
readonly pending: number;
```

Defined in: packages/std/build/collection/index.d.ts:192

Number of in-flight writes for this collection.

***

<a id="collectionpage"></a>

### CollectionPage

Defined in: packages/std/build/collection/index.d.ts:30

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |

#### Properties

<a id="nextcursor"></a>

##### nextCursor

```ts
readonly nextCursor: string | null;
```

Defined in: packages/std/build/collection/index.d.ts:32

<a id="rows"></a>

##### rows

```ts
readonly rows: TRow[];
```

Defined in: packages/std/build/collection/index.d.ts:31

***

<a id="collectionpagequery"></a>

### CollectionPageQuery

Defined in: packages/std/build/collection/index.d.ts:35

A collection page keeps the familiar row result while exposing its opaque continuation.

#### Extends

- [`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery)\<`TRow`[]\>

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="current"></a>

##### current

```ts
readonly current: TRow[] | undefined;
```

Defined in: packages/std/build/collection/index.d.ts:26

###### Inherited from

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery).[`current`](/docs/api-reference/std/build/collection.md#current-1)

<a id="error"></a>

##### error

```ts
readonly error: Error | undefined;
```

Defined in: packages/std/build/collection/index.d.ts:28

###### Inherited from

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery).[`error`](/docs/api-reference/std/build/collection.md#error-1)

<a id="loading"></a>

##### loading

```ts
readonly loading: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:27

###### Inherited from

[`RemoteQuery`](/docs/api-reference/std/build/collection.md#remotequery).[`loading`](/docs/api-reference/std/build/collection.md#loading-1)

<a id="nextcursor-1"></a>

##### nextCursor

```ts
readonly nextCursor: string | null | undefined;
```

Defined in: packages/std/build/collection/index.d.ts:36

***

<a id="collectionquery"></a>

### CollectionQuery

Defined in: packages/std/build/collection/index.d.ts:128

#### Extends

- [`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery)\<`TRow`\>

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="after"></a>

##### after?

```ts
readonly optional after?: string;
```

Defined in: packages/std/build/collection/index.d.ts:131

Opaque continuation returned by the previous page.

<a id="bypass_secret-2"></a>

##### bypass\_secret?

```ts
readonly optional bypass_secret?: string;
```

Defined in: packages/std/build/collection/index.d.ts:126

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`bypass_secret`](/docs/api-reference/std/build/collection.md#bypass_secret)

<a id="columns-2"></a>

##### columns?

```ts
readonly optional columns?: Record<string, boolean>;
```

Defined in: packages/std/build/collection/index.d.ts:124

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`columns`](/docs/api-reference/std/build/collection.md#columns)

<a id="limit-1"></a>

##### limit?

```ts
readonly optional limit?: number;
```

Defined in: packages/std/build/collection/index.d.ts:129

<a id="orderby-2"></a>

##### orderBy?

```ts
readonly optional orderBy?: Partial<Record<Extract<keyof TRow, string>, "asc" | "desc">>;
```

Defined in: packages/std/build/collection/index.d.ts:125

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`orderBy`](/docs/api-reference/std/build/collection.md#orderby)

<a id="search-3"></a>

##### search?

```ts
readonly optional search?: string;
```

Defined in: packages/std/build/collection/index.d.ts:123

Typo-tolerant search across text/phone/enum fields and direct relationship text labels.

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`search`](/docs/api-reference/std/build/collection.md#search)

<a id="where-2"></a>

##### where?

```ts
readonly optional where?: Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:121

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`where`](/docs/api-reference/std/build/collection.md#where)

<a id="with-2"></a>

##### with?

```ts
readonly optional with?: Record<string, unknown>;
```

Defined in: packages/std/build/collection/index.d.ts:120

###### Inherited from

[`CollectionBaseQuery`](/docs/api-reference/std/build/collection.md#collectionbasequery).[`with`](/docs/api-reference/std/build/collection.md#with)

***

<a id="collectionrecord"></a>

### CollectionRecord

Defined in: packages/std/build/collection/index.d.ts:22

#### Indexable

```ts
[field: string]: unknown
```

***

<a id="collectionrecordhistoryentry"></a>

### CollectionRecordHistoryEntry

Defined in: packages/std/build/collection/index.d.ts:216

#### Properties

<a id="validfrom"></a>

##### validFrom

```ts
readonly validFrom: string;
```

Defined in: packages/std/build/collection/index.d.ts:218

<a id="validto"></a>

##### validTo

```ts
readonly validTo: string | null;
```

Defined in: packages/std/build/collection/index.d.ts:219

<a id="values-1"></a>

##### values

```ts
readonly values: CollectionRecord;
```

Defined in: packages/std/build/collection/index.d.ts:217

<a id="version"></a>

##### version

```ts
readonly version: number;
```

Defined in: packages/std/build/collection/index.d.ts:220

***

<a id="collectionrecordoperations"></a>

### CollectionRecordOperations

Defined in: packages/std/build/collection/index.d.ts:213

#### Methods

<a id="findmany-3"></a>

##### findMany()

```ts
findMany(collectionName, query?): CollectionPageQuery<CollectionRecord>;
```

Defined in: packages/std/build/collection/index.d.ts:214

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `query?` | [`CollectionQuery`](/docs/api-reference/std/build/collection.md#collectionquery)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\> |

###### Returns

[`CollectionPageQuery`](/docs/api-reference/std/build/collection.md#collectionpagequery)\<[`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord)\>

***

<a id="collectionrelationoptions"></a>

### CollectionRelationOptions

Defined in: packages/std/build/collection/index.d.ts:153

How a relationship presents its option set, declared inline wherever the relationship is
rendered — a table column, a form field, a matrix cell.

A relationship is a picker: the stored value is only the key that selects one option, so what a
surface needs is the option set, not a property of the target collection. The same target reads
differently in different places (an employment might be an employee number here and a name plus
department there), which is why this is declared per use and not inherited from the model.

`TRow` is the *target* collection's row, so `label` and the field lists are checked against the
records actually being picked from.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |

#### Properties

<a id="filters-1"></a>

##### filters?

```ts
readonly optional filters?: readonly Extract<keyof TRow, string>[];
```

Defined in: packages/std/build/collection/index.d.ts:163

Fields the picker offers as filter controls, so a long option list stays navigable.

<a id="label-1"></a>

##### label

```ts
readonly label: (record) => string;
```

Defined in: packages/std/build/collection/index.d.ts:155

How one option reads. Required — nothing is inferred, and without it a value shows as its id.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | `TRow` |

###### Returns

`string`

<a id="limit-2"></a>

##### limit?

```ts
readonly optional limit?: number;
```

Defined in: packages/std/build/collection/index.d.ts:159

<a id="orderby-3"></a>

##### orderBy?

```ts
readonly optional orderBy?: Partial<Record<Extract<keyof TRow, string>, "asc" | "desc">>;
```

Defined in: packages/std/build/collection/index.d.ts:158

<a id="searchfields"></a>

##### searchFields?

```ts
readonly optional searchFields?: readonly Extract<keyof TRow, string>[];
```

Defined in: packages/std/build/collection/index.d.ts:161

Fields the picker's search box matches. Defaults to the server's search behaviour.

<a id="where-3"></a>

##### where?

```ts
readonly optional where?: Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:157

Narrows which records are offered.

***

<a id="collectionrelationship"></a>

### CollectionRelationship

Defined in: packages/std/build/collection/index.d.ts:106

#### Properties

<a id="cardinality"></a>

##### cardinality

```ts
readonly cardinality: "one" | "many";
```

Defined in: packages/std/build/collection/index.d.ts:109

<a id="name-2"></a>

##### name

```ts
readonly name: string;
```

Defined in: packages/std/build/collection/index.d.ts:107

<a id="target"></a>

##### target

```ts
readonly target: string;
```

Defined in: packages/std/build/collection/index.d.ts:108

***

<a id="collectiontype"></a>

### CollectionType

Defined in: packages/std/build/collection/index.d.ts:38

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |
| `TCreate` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |
| `TUpdate` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |
| `TMutation` *extends* `object` | [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) |

#### Properties

<a id="create"></a>

##### create

```ts
readonly create: TCreate;
```

Defined in: packages/std/build/collection/index.d.ts:40

<a id="mutation"></a>

##### mutation?

```ts
readonly optional mutation?: TMutation;
```

Defined in: packages/std/build/collection/index.d.ts:43

Exact recursively generated graph accepted by the declarative browser mutation.

<a id="row"></a>

##### row

```ts
readonly row: TRow;
```

Defined in: packages/std/build/collection/index.d.ts:39

<a id="update"></a>

##### update

```ts
readonly update: TUpdate;
```

Defined in: packages/std/build/collection/index.d.ts:41

***

<a id="remotequery"></a>

### RemoteQuery

Defined in: packages/std/build/collection/index.d.ts:25

#### Extends

- `PromiseLike`\<`T`\>

#### Extended by

- [`CollectionPageQuery`](/docs/api-reference/std/build/collection.md#collectionpagequery)

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Properties

<a id="current-1"></a>

##### current

```ts
readonly current: T | undefined;
```

Defined in: packages/std/build/collection/index.d.ts:26

<a id="error-1"></a>

##### error

```ts
readonly error: Error | undefined;
```

Defined in: packages/std/build/collection/index.d.ts:28

<a id="loading-1"></a>

##### loading

```ts
readonly loading: boolean;
```

Defined in: packages/std/build/collection/index.d.ts:27

## Type Aliases

<a id="collectioncreateinput"></a>

### CollectionCreateInput

```ts
type CollectionCreateInput<TCollection> = TCollection["create"];
```

Defined in: packages/std/build/collection/index.d.ts:48

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

***

<a id="collectionfieldname-1"></a>

### CollectionFieldName

```ts
type CollectionFieldName<TCollection> = Extract<keyof CollectionRow<TCollection>, string>;
```

Defined in: packages/std/build/collection/index.d.ts:51

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

***

<a id="collectiongroupedresult"></a>

### CollectionGroupedResult

```ts
type CollectionGroupedResult<TRow> = Readonly<Record<string, TRow[]>>;
```

Defined in: packages/std/build/collection/index.d.ts:140

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

***

<a id="collectionmutationinput"></a>

### CollectionMutationInput

```ts
type CollectionMutationInput<TCollection> = NonNullable<TCollection["mutation"]>;
```

Defined in: packages/std/build/collection/index.d.ts:50

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

***

<a id="collectionregistry"></a>

### CollectionRegistry

```ts
type CollectionRegistry = Readonly<Record<string, CollectionType<object, object, object>>>;
```

Defined in: packages/std/build/collection/index.d.ts:45

***

<a id="collectionrow"></a>

### CollectionRow

```ts
type CollectionRow<TCollection> = TCollection["row"];
```

Defined in: packages/std/build/collection/index.d.ts:47

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

***

<a id="collectionupdateinput"></a>

### CollectionUpdateInput

```ts
type CollectionUpdateInput<TCollection> = TCollection["update"];
```

Defined in: packages/std/build/collection/index.d.ts:49

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollection` *extends* [`CollectionType`](/docs/api-reference/std/build/collection.md#collectiontype)\<`object`, `object`, `object`\> |

***

<a id="collectionwhere"></a>

### CollectionWhere

```ts
type CollectionWhere<_TRow> = Readonly<Record<string, unknown>>;
```

Defined in: packages/std/build/collection/index.d.ts:118

#### Type Parameters

| Type Parameter |
| ------ |
| `_TRow` *extends* `object` |

***

<a id="erasedcollectionregistry"></a>

### ErasedCollectionRegistry

```ts
type ErasedCollectionRegistry = Readonly<Record<string, CollectionType>>;
```

Defined in: packages/std/build/collection/index.d.ts:46

***

<a id="numericrenderervariant"></a>

### NumericRendererVariant

```ts
type NumericRendererVariant =
  | {
  type: "number";
}
  | {
  max: number;
  type: "star-rating";
}
  | {
  denominator: number;
  type: "progress";
};
```

Defined in: packages/std/build/collection/index.d.ts:52

## Variables

<a id="collection_search_max_length"></a>

### COLLECTION\_SEARCH\_MAX\_LENGTH

```ts
const COLLECTION_SEARCH_MAX_LENGTH: 200 = 200;
```

Defined in: packages/std/build/collection/index.d.ts:93

## Functions

<a id="collectionsearchtrigramindexname"></a>

### collectionSearchTrigramIndexName()

```ts
function collectionSearchTrigramIndexName(tableName, columnName): string;
```

Defined in: packages/std/build/collection/index.d.ts:105

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `columnName` | `string` |

#### Returns

`string`

***

<a id="issearchablecollectionfield"></a>

### isSearchableCollectionField()

```ts
function isSearchableCollectionField(field): boolean;
```

Defined in: packages/std/build/collection/index.d.ts:104

Whether a field is searchable — the predicate every search path and the trigram index creation
agree on. Search runs over exactly the fields that got a trigram index, and both are explicit
opt-ins: a non-array text/phone/enum field is only searchable when the author wrote
`text({ search: true })` (or the equivalent on `phone()`/`enums()`).

The trigram index itself is language-agnostic: `gin_trgm_ops` indexes character trigrams, not
words, so the same index serves substring search in any script — CJK, accented Latin, RTL —
without dictionaries or tokenizers. The index and the search must never assume a language.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield) |

#### Returns

`boolean`

## References

<a id="issystemcollectionfield"></a>

### isSystemCollectionField

Re-exports [isSystemCollectionField](/docs/api-reference/std/build/collection/system-fields.md#issystemcollectionfield)

***

<a id="labeltermtext"></a>

### labelTermText

Re-exports [labelTermText](/docs/api-reference/std/build/collection/record-label.md#labeltermtext)

***

<a id="resolverecordlabel"></a>

### resolveRecordLabel

Re-exports [resolveRecordLabel](/docs/api-reference/std/build/collection/record-label.md#resolverecordlabel)

***

<a id="system_collection_field_names"></a>

### SYSTEM\_COLLECTION\_FIELD\_NAMES

Re-exports [SYSTEM_COLLECTION_FIELD_NAMES](/docs/api-reference/std/build/collection/system-fields.md#system_collection_field_names)
