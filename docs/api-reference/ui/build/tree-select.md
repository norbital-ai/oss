[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/tree-select

# ui/build/tree-select

## Interfaces

<a id="basetreeitem"></a>

### BaseTreeItem

Defined in: packages/ui/build/tree-select/index.d.ts:31

Base item structure used for initializing the tree

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Properties

<a id="action"></a>

##### action?

```ts
optional action?: NodeActionCallback<TMetadata>;
```

Defined in: packages/ui/build/tree-select/index.d.ts:47

Optional action to render next to the node

<a id="children"></a>

##### children?

```ts
optional children?: BaseTreeItem<TMetadata>[];
```

Defined in: packages/ui/build/tree-select/index.d.ts:41

Child items under this node

<a id="icon"></a>

##### icon

```ts
icon: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:39

Icon identifier for the node

<a id="id"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:33

Unique identifier for the node

<a id="metadata"></a>

##### metadata

```ts
metadata: TMetadata;
```

Defined in: packages/ui/build/tree-select/index.d.ts:45

Custom metadata associated with this item

<a id="required"></a>

##### required?

```ts
optional required?: boolean;
```

Defined in: packages/ui/build/tree-select/index.d.ts:43

Whether this item is required (when in multiple selection mode)

<a id="searchtext"></a>

##### searchText?

```ts
optional searchText?: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:37

Additional aliases and metadata included when filtering the tree

<a id="title"></a>

##### title

```ts
title: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:35

Display text for the node

***

<a id="treeselectprops"></a>

### TreeSelectProps

Defined in: packages/ui/build/tree-select/index.d.ts:52

Props interface for the TreeSelect component

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Properties

<a id="containerclass"></a>

##### containerClass?

```ts
optional containerClass?: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:68

Additional CSS class for the container

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/tree-select/index.d.ts:60

Disable all interactions and focus

<a id="multiple"></a>

##### multiple?

```ts
optional multiple?: boolean;
```

Defined in: packages/ui/build/tree-select/index.d.ts:70

Whether to allow multiple selection

<a id="onchange"></a>

##### onChange?

```ts
optional onChange?: (state) => void;
```

Defined in: packages/ui/build/tree-select/index.d.ts:58

Callback when selection changes

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | \{ `disabled`: readonly `string`[]; `selected`: readonly `string`[]; \} |
| `state.disabled` | readonly `string`[] |
| `state.selected` | readonly `string`[] |

###### Returns

`void`

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/tree-select/index.d.ts:62

Prevent selection changes but allow navigation/expand

<a id="rootitems"></a>

##### rootItems

```ts
rootItems: readonly BaseTreeItem<TMetadata>[];
```

Defined in: packages/ui/build/tree-select/index.d.ts:54

Root items to display in the tree

<a id="searchplaceholder"></a>

##### searchPlaceholder?

```ts
optional searchPlaceholder?: string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:66

Placeholder shown in the search input

<a id="showsearch"></a>

##### showSearch?

```ts
optional showSearch?: boolean;
```

Defined in: packages/ui/build/tree-select/index.d.ts:64

Whether to show the search input

<a id="value"></a>

##### value?

```ts
optional value?: object;
```

Defined in: packages/ui/build/tree-select/index.d.ts:56

Selection state (bindable)

###### disabled

```ts
readonly disabled: readonly string[];
```

###### selected

```ts
readonly selected: readonly string[];
```

## Type Aliases

<a id="nodeactioncallback"></a>

### NodeActionCallback

```ts
type NodeActionCallback<TMetadata> = (node) =>
  | RenderComponentConfig<Component<Record<string, unknown>>>
  | RenderSnippetConfig<unknown>
  | string;
```

Defined in: packages/ui/build/tree-select/index.d.ts:27

Callback type for node actions

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `node` | [`TreeNodes`](/docs/api-reference/ui/build/tree-select.md#treenodes)\<`TMetadata`\> |

#### Returns

  \| [`RenderComponentConfig`](/docs/api-reference/ui/build/utils.md#rendercomponentconfig)\<`Component`\<`Record`\<`string`, `unknown`\>\>\>
  \| [`RenderSnippetConfig`](/docs/api-reference/ui/build/utils.md#rendersnippetconfig)\<`unknown`\>
  \| `string`

***

<a id="selectionstate"></a>

### SelectionState

```ts
type SelectionState = typeof SelectionStateSchema.Type;
```

Defined in: packages/ui/build/tree-select/index.d.ts:23

***

<a id="treenodes"></a>

### TreeNodes

```ts
type TreeNodes<TMetadata> =
  | ConfirmationProps<TMetadata>
  | ConfirmationProps<TMetadata>
| ConfirmationProps<TMetadata>;
```

Defined in: packages/ui/build/tree-select/index.d.ts:15

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

***

<a id="treeselectstateprops"></a>

### TreeSelectStateProps

```ts
type TreeSelectStateProps<TMetadata> = TreeSelectProps<TMetadata>;
```

Defined in: packages/ui/build/tree-select/index.d.ts:75

Props interface for TreeState initialization

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

## Variables

<a id="auto_scroll_threshold"></a>

### AUTO\_SCROLL\_THRESHOLD

```ts
const AUTO_SCROLL_THRESHOLD: 0.2 = 0.2;
```

Defined in: packages/ui/build/tree-select/index.d.ts:12

Threshold percentage (0-1) from viewport edge that triggers auto-scroll
0.2 means scrolling starts when element is within 20% of the viewport edge

***

<a id="isparentnode"></a>

### isParentNode

```ts
const isParentNode: typeof ConfirmationProps;
```

Defined in: packages/ui/build/tree-select/index.d.ts:14

***

<a id="isrequiredchildnode"></a>

### isRequiredChildNode

```ts
const isRequiredChildNode: typeof ConfirmationProps;
```

Defined in: packages/ui/build/tree-select/index.d.ts:13

***

<a id="root_node_id"></a>

### ROOT\_NODE\_ID

```ts
const ROOT_NODE_ID: "ROOT" = "ROOT";
```

Defined in: packages/ui/build/tree-select/index.d.ts:7

***

<a id="selectionstateschema"></a>

### SelectionStateSchema

```ts
const SelectionStateSchema: Schema.Struct<{
  disabled: Schema.$Array<Schema.String>;
  selected: Schema.$Array<Schema.String>;
}>;
```

Defined in: packages/ui/build/tree-select/index.d.ts:19

Selection state interface defining which nodes are selected or disabled

## References

<a id="requiredtreechildnode"></a>

### RequiredTreeChildNode

Renames and re-exports [ConfirmationProps](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops)

***

<a id="treechildnode"></a>

### TreeChildNode

Renames and re-exports [ConfirmationProps](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops)

***

<a id="treeparentnode"></a>

### TreeParentNode

Renames and re-exports [ConfirmationProps](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops)

***

<a id="treestate"></a>

### TreeState

Renames and re-exports [ConfirmationProps](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops)
