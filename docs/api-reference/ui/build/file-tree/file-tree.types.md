[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/file-tree/file-tree.types

# ui/build/file-tree/file-tree.types

## Type Aliases

<a id="filetreeentry"></a>

### FileTreeEntry

```ts
type FileTreeEntry = object;
```

Defined in: packages/ui/build/file-tree/file-tree.types.d.ts:1

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-name"></a> `name` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:2 |
| <a id="property-path"></a> `path` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:5 |
| <a id="property-sizebytes"></a> `sizeBytes` | `number` | packages/ui/build/file-tree/file-tree.types.d.ts:4 |
| <a id="property-type"></a> `type` | `"directory"` \| `"file"` | packages/ui/build/file-tree/file-tree.types.d.ts:3 |
| <a id="property-writable"></a> `writable?` | `boolean` | packages/ui/build/file-tree/file-tree.types.d.ts:6 |

***

<a id="filetreeentrybadge"></a>

### FileTreeEntryBadge

```ts
type FileTreeEntryBadge = object;
```

Defined in: packages/ui/build/file-tree/file-tree.types.d.ts:15

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-class"></a> `class?` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:17 |
| <a id="property-label"></a> `label` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:16 |

***

<a id="filetreepresencepeer"></a>

### FileTreePresencePeer

```ts
type FileTreePresencePeer = object;
```

Defined in: packages/ui/build/file-tree/file-tree.types.d.ts:11

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-color"></a> `color` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:12 |
| <a id="property-label-1"></a> `label` | `string` | packages/ui/build/file-tree/file-tree.types.d.ts:13 |

***

<a id="filetreeprops"></a>

### FileTreeProps

```ts
type FileTreeProps = object;
```

Defined in: packages/ui/build/file-tree/file-tree.types.d.ts:19

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-candelete"></a> `canDelete?` | (`path`, `entry`) => `boolean` | - | packages/ui/build/file-tree/file-tree.types.d.ts:23 |
| <a id="property-class-1"></a> `class?` | `string` | - | packages/ui/build/file-tree/file-tree.types.d.ts:33 |
| <a id="property-deletedisabled"></a> `deleteDisabled?` | `boolean` | - | packages/ui/build/file-tree/file-tree.types.d.ts:25 |
| <a id="property-entries"></a> `entries` | [`FileTreeEntry`](/docs/api-reference/ui/build/file-tree/file-tree.types.md#filetreeentry)[] | - | packages/ui/build/file-tree/file-tree.types.d.ts:20 |
| <a id="property-getentrybadge"></a> `getEntryBadge?` | (`entry`) => \| [`FileTreeEntryBadge`](/docs/api-reference/ui/build/file-tree/file-tree.types.md#filetreeentrybadge) \| `null` | Optional trailing status badge (e.g. U/M/D). Also tints the filename when `class` is set. | packages/ui/build/file-tree/file-tree.types.d.ts:30 |
| <a id="property-getentryicon"></a> `getEntryIcon?` | (`entry`, `context`) => `string` | - | packages/ui/build/file-tree/file-tree.types.d.ts:28 |
| <a id="property-ismutedentry"></a> `isMutedEntry?` | (`entry`) => `boolean` | - | packages/ui/build/file-tree/file-tree.types.d.ts:31 |
| <a id="property-ondelete"></a> `onDelete?` | (`path`, `entry`) => `void` | - | packages/ui/build/file-tree/file-tree.types.d.ts:24 |
| <a id="property-onselect"></a> `onSelect?` | (`path`, `entry`) => `void` | - | packages/ui/build/file-tree/file-tree.types.d.ts:22 |
| <a id="property-ontoggle"></a> `onToggle?` | (`path`) => `Effect.Effect`\<[`FileTreeEntry`](/docs/api-reference/ui/build/file-tree/file-tree.types.md#filetreeentry)[], `unknown`\> | - | packages/ui/build/file-tree/file-tree.types.d.ts:21 |
| <a id="property-presencebypath"></a> `presenceByPath?` | `Record`\<`string`, readonly [`FileTreePresencePeer`](/docs/api-reference/ui/build/file-tree/file-tree.types.md#filetreepresencepeer)[]\> | - | packages/ui/build/file-tree/file-tree.types.d.ts:27 |
| <a id="property-selectedpath"></a> `selectedPath?` | `string` \| `null` | - | packages/ui/build/file-tree/file-tree.types.d.ts:26 |
| <a id="property-variant"></a> `variant?` | `"default"` \| `"dark"` | - | packages/ui/build/file-tree/file-tree.types.d.ts:32 |
