[**Norbital API Reference v0.0.1**](../../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/markdown-editor/extensions/attachment/attachment-extension.svelte

# ui/build/markdown-editor/extensions/attachment/attachment-extension.svelte

## Functions

<a id="createfileattachmentextension"></a>

### createFileAttachmentExtension()

```ts
function createFileAttachmentExtension(options): Node<FileAttachmentOptions, any>;
```

Defined in: packages/ui/build/markdown-editor/extensions/attachment/attachment-extension.svelte.d.ts:36

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `client`: [`IFileUploadClient`](/docs/api-reference/ui/build/file-upload/types.md#ifileuploadclient); `translate?`: (`key`, `vars?`) => `string`; \} |
| `options.client` | [`IFileUploadClient`](/docs/api-reference/ui/build/file-upload/types.md#ifileuploadclient) |
| `options.translate?` | (`key`, `vars?`) => `string` |

#### Returns

`Node`\<`FileAttachmentOptions`, `any`\>

***

<a id="extractfilemetadata"></a>

### extractFileMetadata()

```ts
function extractFileMetadata(node):
  | {
  id?: string | null;
  indexed_status?: string | null;
  metadata?:   | {
     structure_hint: string;
     summary: string;
   }
     | null;
  name: string;
  size: number;
  type: string;
  url: string | null | undefined;
}
  | null;
```

Defined in: packages/ui/build/markdown-editor/extensions/attachment/attachment-extension.svelte.d.ts:35

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `node` | `Node` |

#### Returns

  \| \{
  `id?`: `string` \| `null`;
  `indexed_status?`: `string` \| `null`;
  `metadata?`:   \| \{
     `structure_hint`: `string`;
     `summary`: `string`;
   \}
     \| `null`;
  `name`: `string`;
  `size`: `number`;
  `type`: `string`;
  `url`: `string` \| `null` \| `undefined`;
\}
  \| `null`
