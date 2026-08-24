[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/file/file.types

# ui/build/data-renderer/file/file.types

## Functions

<a id="filereffromfilevalue"></a>

### fileRefFromFileValue()

```ts
function fileRefFromFileValue(file): object;
```

Defined in: packages/ui/build/data-renderer/file/file.types.d.ts:28

Persists the object-store key an upload returned, not its UI upload id.

Existing hydrated values use the storage key as `id`; a fresh upload deliberately has two
identities because its stored key also carries the file extension. `FileInput` speaks the shared
display shape, so the upload-only member is read structurally at this boundary.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `file` | \{ `id`: `string`; `indexed_error?`: `string` \| `null`; `indexed_status?`: `"pending"` \| `"indexing"` \| `"ready"` \| `"failed"` \| `"not_indexable"`; `metadata?`: \{ `structure_hint`: `string`; `summary`: `string`; \}; `name`: `string`; `size`: `number`; `type`: `string`; `url`: `string`; \} |
| `file.id` | `string` |
| `file.indexed_error?` | `string` \| `null` |
| `file.indexed_status?` | `"pending"` \| `"indexing"` \| `"ready"` \| `"failed"` \| `"not_indexable"` |
| `file.metadata?` | \{ `structure_hint`: `string`; `summary`: `string`; \} |
| `file.metadata.structure_hint` | `string` |
| `file.metadata.summary` | `string` |
| `file.name` | `string` |
| `file.size` | `number` |
| `file.type` | `string` |
| `file.url` | `string` |

#### Returns

`object`

##### file\_name

```ts
readonly file_name: string;
```

##### file\_size

```ts
readonly file_size: number;
```

##### mime\_type

```ts
readonly mime_type: string;
```

##### storage\_key

```ts
readonly storage_key: string;
```

***

<a id="filevaluefromfileref"></a>

### fileValueFromFileRef()

```ts
function fileValueFromFileRef(ref, urlFor): object;
```

Defined in: packages/ui/build/data-renderer/file/file.types.d.ts:20

Hydrates a stored reference without assuming anything about the host's public file route.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ref` | \{ `file_name`: `string`; `file_size`: `number`; `mime_type`: `string`; `storage_key`: `string`; \} |
| `ref.file_name` | `string` |
| `ref.file_size` | `number` |
| `ref.mime_type` | `string` |
| `ref.storage_key` | `string` |
| `urlFor` | (`storageKey`) => `string` |

#### Returns

`object`

##### id

```ts
readonly id: string;
```

##### indexed\_error?

```ts
readonly optional indexed_error?: string | null;
```

##### indexed\_status?

```ts
readonly optional indexed_status?: "pending" | "indexing" | "ready" | "failed" | "not_indexable";
```

##### metadata?

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

##### name

```ts
readonly name: string;
```

##### size

```ts
readonly size: number;
```

##### type

```ts
readonly type: string;
```

##### url

```ts
readonly url: string;
```

***

<a id="readfileref"></a>

### readFileRef()

```ts
function readFileRef(candidate):
  | {
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_key: string;
}
  | null;
```

Defined in: packages/ui/build/data-renderer/file/file.types.d.ts:18

The tolerant read of a stored file-column value: older uploads predate the column carrying its
own display facts, so missing ones fall back to the only stable identity a file has.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidate` | `unknown` |

#### Returns

  \| \{
  `file_name`: `string`;
  `file_size`: `number`;
  `mime_type`: `string`;
  `storage_key`: `string`;
\}
  \| `null`
