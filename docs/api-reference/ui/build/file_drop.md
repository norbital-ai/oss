[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/file\_drop

# ui/build/file\_drop

## Interfaces

<a id="filedropzoneprops"></a>

### FileDropZoneProps

Defined in: packages/ui/build/file\_drop/index.d.ts:5

#### Extends

- `Omit`\<`HTMLInputAttributes`, `"multiple"` \| `"accept"`\>

#### Indexable

```ts
[key: symbol]: false | Attachment<HTMLInputElement> | null | undefined
```

```ts
[key: `data-${string}`]: any
```

#### Properties

<a id="accept"></a>

##### accept?

```ts
optional accept?: string[];
```

Defined in: packages/ui/build/file\_drop/index.d.ts:18

<a id="client"></a>

##### client

```ts
client: IFileUploadClient;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:6

<a id="filecount"></a>

##### fileCount?

```ts
optional fileCount?: number;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:9

<a id="iscompact"></a>

##### isCompact?

```ts
optional isCompact?: boolean;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:7

<a id="maxfiles"></a>

##### maxFiles?

```ts
optional maxFiles?: number;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:8

<a id="maxfilesize"></a>

##### maxFileSize?

```ts
optional maxFileSize?: number;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:10

<a id="onfilerejected"></a>

##### onFileRejected?

```ts
optional onFileRejected?: (opts) => void;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:11

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | \{ `file`: `File`; `reason`: [`FileRejectedReason`](/docs/api-reference/ui/build/file_drop.md#filerejectedreason); \} |
| `opts.file` | `File` |
| `opts.reason` | [`FileRejectedReason`](/docs/api-reference/ui/build/file_drop.md#filerejectedreason) |

###### Returns

`void`

<a id="onremovefile"></a>

##### onRemoveFile?

```ts
optional onRemoveFile?: (index) => void;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:20

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |

###### Returns

`void`

<a id="onuploaderror"></a>

##### onUploadError?

```ts
optional onUploadError?: (error, file?) => void;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:17

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | `string` |
| `file?` | `File` |

###### Returns

`void`

<a id="onuploadstart"></a>

##### onUploadStart?

```ts
optional onUploadStart?: (files) => void;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:15

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `files` | `File`[] |

###### Returns

`void`

<a id="onuploadsuccess"></a>

##### onUploadSuccess?

```ts
optional onUploadSuccess?: (files) => void;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:16

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `files` | `object`[] |

###### Returns

`void`

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/file\_drop/index.d.ts:21

###### Overrides

```ts
Omit.readonly
```

<a id="uploadedfiles"></a>

##### uploadedFiles?

```ts
optional uploadedFiles?: object[];
```

Defined in: packages/ui/build/file\_drop/index.d.ts:19

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

###### type

```ts
readonly type: string;
```

###### url

```ts
readonly url: string;
```

## Type Aliases

<a id="filerejectedreason"></a>

### FileRejectedReason

```ts
type FileRejectedReason =
  | "Maximum file size exceeded"
  | "File type not allowed"
  | "Maximum files uploaded";
```

Defined in: packages/ui/build/file\_drop/index.d.ts:4
