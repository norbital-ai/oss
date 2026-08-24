[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/markdown-editor/extensions/slash-commands.svelte

# ui/build/markdown-editor/extensions/slash-commands.svelte

## Interfaces

<a id="commanditem"></a>

### CommandItem

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:10

#### Properties

<a id="command"></a>

##### command

```ts
command: (opts) => void;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:16

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | \{ `editor`: `Editor`; `range`: `Range`; \} |
| `opts.editor` | `Editor` |
| `opts.range` | `Range` |

###### Returns

`void`

<a id="description"></a>

##### description?

```ts
optional description?: string;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:12

<a id="icon"></a>

##### icon

```ts
icon: string;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:13

<a id="keywords"></a>

##### keywords?

```ts
optional keywords?: string[];
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:15

<a id="shortcut"></a>

##### shortcut?

```ts
optional shortcut?: string;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:14

<a id="title"></a>

##### title

```ts
title: string;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:11

## Functions

<a id="createslashcommands"></a>

### createSlashCommands()

```ts
function createSlashCommands(stateAccessor): Extension<{
  suggestion: {
     char: "/";
  };
}, any>;
```

Defined in: packages/ui/build/markdown-editor/extensions/slash-commands.svelte.d.ts:27

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `stateAccessor` | \{ `get`: () => `SlashCommandState`; `setFlags`: (`flags`) => `void`; `setIndex`: (`index`) => `void`; \} |
| `stateAccessor.get` | () => `SlashCommandState` |
| `stateAccessor.setFlags` | (`flags`) => `void` |
| `stateAccessor.setIndex` | (`index`) => `void` |

#### Returns

`Extension`\<\{
  `suggestion`: \{
     `char`: `"/"`;
  \};
\}, `any`\>
