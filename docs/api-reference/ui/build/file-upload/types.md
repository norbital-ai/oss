[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/file-upload/types

# ui/build/file-upload/types

## Interfaces

<a id="beginuploadoptions"></a>

### BeginUploadOptions

Defined in: packages/ui/build/file-upload/types.d.ts:15

#### Properties

<a id="onprogress"></a>

##### onProgress?

```ts
optional onProgress?: (stage) => void;
```

Defined in: packages/ui/build/file-upload/types.d.ts:18

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `stage` | \| `"error"` \| `"uploading"` \| `"converting"` \| `"summarizing"` \| `"complete"` \| `"aborted"` |

###### Returns

`void`

<a id="stream"></a>

##### stream?

```ts
optional stream?: boolean;
```

Defined in: packages/ui/build/file-upload/types.d.ts:16

<a id="uploadid"></a>

##### uploadId?

```ts
optional uploadId?: string;
```

Defined in: packages/ui/build/file-upload/types.d.ts:17

***

<a id="ifileuploadclient"></a>

### IFileUploadClient

Defined in: packages/ui/build/file-upload/types.d.ts:51

#### Properties

<a id="uploads"></a>

##### uploads

```ts
readonly uploads: UploadEntry[];
```

Defined in: packages/ui/build/file-upload/types.d.ts:52

#### Methods

<a id="beginupload"></a>

##### beginUpload()

```ts
beginUpload(file, options?): object;
```

Defined in: packages/ui/build/file-upload/types.d.ts:55

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `file` | `File` |
| `options?` | [`BeginUploadOptions`](/docs/api-reference/ui/build/file-upload/types.md#beginuploadoptions) |

###### Returns

`object`

###### effect

```ts
effect: Effect<{
  id: string;
  indexed_error?: string | null;
  indexed_status?: "pending" | "indexing" | "ready" | "failed" | "not_indexable";
  metadata?: {
     structure_hint: string;
     summary: string;
  };
  name: string;
  size: number;
  storageKey: string;
  type: string;
  url: string;
}, unknown>;
```

###### id

```ts
id: string;
```

<a id="cancel"></a>

##### cancel()

```ts
cancel(entryId): void;
```

Defined in: packages/ui/build/file-upload/types.d.ts:60

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `entryId` | `string` |

###### Returns

`void`

<a id="clear"></a>

##### clear()

```ts
clear(entryId): void;
```

Defined in: packages/ui/build/file-upload/types.d.ts:62

Remove a finished or errored entry from the uploads list (cancels if still in flight).

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `entryId` | `string` |

###### Returns

`void`

<a id="clearalluploads"></a>

##### clearAllUploads()

```ts
clearAllUploads(): void;
```

Defined in: packages/ui/build/file-upload/types.d.ts:63

###### Returns

`void`

<a id="delete"></a>

##### delete()

```ts
delete(fileUrl): Effect<void, unknown>;
```

Defined in: packages/ui/build/file-upload/types.d.ts:59

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `fileUrl` | `string` |

###### Returns

`Effect`\<`void`, `unknown`\>

<a id="upload"></a>

##### upload()

```ts
upload(file, options?): Effect<{
  id: string;
  indexed_error?: string | null;
  indexed_status?: "pending" | "indexing" | "ready" | "failed" | "not_indexable";
  metadata?: {
     structure_hint: string;
     summary: string;
  };
  name: string;
  size: number;
  storageKey: string;
  type: string;
  url: string;
}, unknown>;
```

Defined in: packages/ui/build/file-upload/types.d.ts:53

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `file` | `File` |
| `options?` | [`UploadOptions`](/docs/api-reference/ui/build/file-upload/types.md#uploadoptions) |

###### Returns

`Effect`\<\{
  `id`: `string`;
  `indexed_error?`: `string` \| `null`;
  `indexed_status?`: `"pending"` \| `"indexing"` \| `"ready"` \| `"failed"` \| `"not_indexable"`;
  `metadata?`: \{
     `structure_hint`: `string`;
     `summary`: `string`;
  \};
  `name`: `string`;
  `size`: `number`;
  `storageKey`: `string`;
  `type`: `string`;
  `url`: `string`;
\}, `unknown`\>

<a id="uploadmany"></a>

##### uploadMany()

```ts
uploadMany(files, options?): Effect<object[], unknown>;
```

Defined in: packages/ui/build/file-upload/types.d.ts:54

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `files` | `File`[] |
| `options?` | `Pick`\<[`UploadOptions`](/docs/api-reference/ui/build/file-upload/types.md#uploadoptions), `"stream"`\> |

###### Returns

`Effect`\<`object`[], `unknown`\>

***

<a id="uploadentry"></a>

### UploadEntry

Defined in: packages/ui/build/file-upload/types.d.ts:43

#### Properties

<a id="error"></a>

##### error?

```ts
optional error?: string;
```

Defined in: packages/ui/build/file-upload/types.d.ts:49

<a id="file"></a>

##### file

```ts
file: File;
```

Defined in: packages/ui/build/file-upload/types.d.ts:45

<a id="id"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/file-upload/types.d.ts:44

<a id="percent"></a>

##### percent?

```ts
optional percent?: number;
```

Defined in: packages/ui/build/file-upload/types.d.ts:47

<a id="result"></a>

##### result?

```ts
optional result?: object;
```

Defined in: packages/ui/build/file-upload/types.d.ts:48

###### id

```ts
readonly id: string;
```

###### indexed\_error?

```ts
readonly optional indexed_error?: string | null;
```

###### indexed\_status?

```ts
readonly optional indexed_status?: "pending" | "indexing" | "ready" | "failed" | "not_indexable";
```

###### metadata?

```ts
readonly optional metadata?: object;
```

###### metadata.structure\_hint

```ts
readonly structure_hint: string;
```

###### metadata.summary

```ts
readonly summary: string;
```

###### name

```ts
readonly name: string;
```

###### size

```ts
readonly size: number;
```

###### storageKey

```ts
readonly storageKey: string;
```

The object store's key for these bytes, which is what a `file()` column persists.

Not the same string as `id`: the workspace client stores under `<uuid><extension>`
and returns the bare uuid as the id. Reconstructing one from the other by string surgery is
how a read lands on a key nothing was ever written under, so the key is carried.

###### type

```ts
readonly type: string;
```

###### url

```ts
readonly url: string;
```

<a id="stage"></a>

##### stage

```ts
stage:
  | "error"
  | "uploading"
  | "converting"
  | "summarizing"
  | "complete"
  | "aborted";
```

Defined in: packages/ui/build/file-upload/types.d.ts:46

***

<a id="uploadoptions"></a>

### UploadOptions

Defined in: packages/ui/build/file-upload/types.d.ts:9

#### Properties

<a id="onprogress-1"></a>

##### onProgress?

```ts
optional onProgress?: (stage, percent?) => void;
```

Defined in: packages/ui/build/file-upload/types.d.ts:13

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `stage` | \| `"error"` \| `"uploading"` \| `"converting"` \| `"summarizing"` \| `"complete"` \| `"aborted"` |
| `percent?` | `number` |

###### Returns

`void`

<a id="signal"></a>

##### signal?

```ts
optional signal?: AbortSignal;
```

Defined in: packages/ui/build/file-upload/types.d.ts:10

<a id="stream-1"></a>

##### stream?

```ts
optional stream?: boolean;
```

Defined in: packages/ui/build/file-upload/types.d.ts:12

Streaming multipart + SSE progress (default true in app implementation).

## Type Aliases

<a id="uploadresult"></a>

### UploadResult

```ts
type UploadResult = typeof UploadResultSchema.Type;
```

Defined in: packages/ui/build/file-upload/types.d.ts:42

***

<a id="uploadstage"></a>

### UploadStage

```ts
type UploadStage = typeof UploadStageSchema.Type;
```

Defined in: packages/ui/build/file-upload/types.d.ts:6

## Variables

<a id="upload_stage_messages"></a>

### UPLOAD\_STAGE\_MESSAGES

```ts
const UPLOAD_STAGE_MESSAGES: Record<UploadStage, string>;
```

Defined in: packages/ui/build/file-upload/types.d.ts:7

## Functions

<a id="isactiveuploadstage"></a>

### isActiveUploadStage()

```ts
function isActiveUploadStage(stage): boolean;
```

Defined in: packages/ui/build/file-upload/types.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `stage` | \| `"error"` \| `"uploading"` \| `"converting"` \| `"summarizing"` \| `"complete"` \| `"aborted"` |

#### Returns

`boolean`
