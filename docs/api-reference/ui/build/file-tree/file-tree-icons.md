[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/file-tree/file-tree-icons

# ui/build/file-tree/file-tree-icons

## Functions

<a id="getdefaultfiletreeentryicon"></a>

### getDefaultFileTreeEntryIcon()

```ts
function getDefaultFileTreeEntryIcon(entry, context): string;
```

Defined in: packages/ui/build/file-tree/file-tree-icons.d.ts:3

Cursor / VS Code–style Iconify ids for workspace file tree rows.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `entry` | [`FileTreeEntry`](/docs/api-reference/ui/build/file-tree/file-tree.types.md#filetreeentry) |
| `context` | \{ `open`: `boolean`; \} |
| `context.open` | `boolean` |

#### Returns

`string`

***

<a id="getfileiconforpath"></a>

### getFileIconForPath()

```ts
function getFileIconForPath(relativePath): string;
```

Defined in: packages/ui/build/file-tree/file-tree-icons.d.ts:6

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `relativePath` | `string` |

#### Returns

`string`
