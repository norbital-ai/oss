[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/tree-select/tree-select-state.svelte

# ui/build/tree-select/tree-select-state.svelte

## Classes

<a id="requiredtreechildnode"></a>

### RequiredTreeChildNode

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:42

Required child node (selecting it requires all siblings to be selected).

Same field surface as `TreeChildNode`; the type carries the requirement so selection rules can
distinguish the two node kinds while sharing one implementation.

#### Extends

- [`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode)\<`TMetadata`\>

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new RequiredTreeChildNode<TMetadata>(params): RequiredTreeChildNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:32

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | `TreeNodeParams`\<`TMetadata`\> |

###### Returns

[`RequiredTreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#requiredtreechildnode)\<`TMetadata`\>

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`constructor`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#constructor-1)

#### Properties

<a id="action"></a>

##### action?

```ts
readonly optional action?: NodeActionCallback<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:30

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`action`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#action-1)

<a id="depth"></a>

##### depth

```ts
readonly depth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:26

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`depth`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#depth-1)

<a id="displaydepth"></a>

##### displayDepth

```ts
readonly displayDepth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:27

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`displayDepth`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#displaydepth-1)

<a id="icon"></a>

##### icon

```ts
readonly icon: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:25

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`icon`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#icon-1)

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:22

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`id`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#id-1)

<a id="metadata"></a>

##### metadata

```ts
readonly metadata: TMetadata;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:28

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`metadata`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#metadata-1)

<a id="parentnode"></a>

##### parentNode

```ts
readonly parentNode:
  | TreeParentNode<TMetadata>
  | undefined;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:29

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`parentNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#parentnode-1)

<a id="searchtext"></a>

##### searchText?

```ts
readonly optional searchText?: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:24

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`searchText`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#searchtext-1)

<a id="title"></a>

##### title

```ts
readonly title: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:23

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`title`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#title-1)

<a id="treestate"></a>

##### treeState

```ts
readonly treeState: TreeState<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:31

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`treeState`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treestate-1)

#### Accessors

<a id="disabled"></a>

##### disabled

###### Get Signature

```ts
get disabled(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:34

###### Returns

`boolean`

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`disabled`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#disabled-1)

<a id="isselected"></a>

##### isSelected

###### Get Signature

```ts
get isSelected(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:33

###### Returns

`boolean`

###### Inherited from

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode).[`isSelected`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#isselected-1)

***

<a id="treechildnode"></a>

### TreeChildNode

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:21

Regular child node (leaf node)

#### Extended by

- [`RequiredTreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#requiredtreechildnode)

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new TreeChildNode<TMetadata>(params): TreeChildNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:32

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | `TreeNodeParams`\<`TMetadata`\> |

###### Returns

[`TreeChildNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treechildnode)\<`TMetadata`\>

#### Properties

<a id="action-1"></a>

##### action?

```ts
readonly optional action?: NodeActionCallback<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:30

<a id="depth-1"></a>

##### depth

```ts
readonly depth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:26

<a id="displaydepth-1"></a>

##### displayDepth

```ts
readonly displayDepth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:27

<a id="icon-1"></a>

##### icon

```ts
readonly icon: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:25

<a id="id-1"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:22

<a id="metadata-1"></a>

##### metadata

```ts
readonly metadata: TMetadata;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:28

<a id="parentnode-1"></a>

##### parentNode

```ts
readonly parentNode:
  | TreeParentNode<TMetadata>
  | undefined;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:29

<a id="searchtext-1"></a>

##### searchText?

```ts
readonly optional searchText?: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:24

<a id="title-1"></a>

##### title

```ts
readonly title: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:23

<a id="treestate-1"></a>

##### treeState

```ts
readonly treeState: TreeState<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:31

#### Accessors

<a id="disabled-1"></a>

##### disabled

###### Get Signature

```ts
get disabled(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:34

###### Returns

`boolean`

<a id="isselected-1"></a>

##### isSelected

###### Get Signature

```ts
get isSelected(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:33

###### Returns

`boolean`

***

<a id="treeparentnode"></a>

### TreeParentNode

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:47

Parent node (has children)

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new TreeParentNode<TMetadata>(params): TreeParentNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:60

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | `TreeNodeParams`\<`TMetadata`\> & `object` |

###### Returns

[`TreeParentNode`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treeparentnode)\<`TMetadata`\>

#### Properties

<a id="action-2"></a>

##### action?

```ts
readonly optional action?: NodeActionCallback<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:57

<a id="children"></a>

##### children

```ts
readonly children: any[];
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:59

<a id="depth-2"></a>

##### depth

```ts
readonly depth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:53

<a id="displaydepth-2"></a>

##### displayDepth

```ts
readonly displayDepth: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:54

<a id="icon-2"></a>

##### icon

```ts
readonly icon: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:52

<a id="id-2"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:49

<a id="metadata-2"></a>

##### metadata

```ts
readonly metadata: TMetadata;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:55

<a id="parentnode-2"></a>

##### parentNode

```ts
readonly parentNode:
  | TreeParentNode<TMetadata>
  | undefined;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:56

<a id="searchtext-2"></a>

##### searchText?

```ts
readonly optional searchText?: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:51

<a id="title-2"></a>

##### title

```ts
readonly title: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:50

<a id="treestate-2"></a>

##### treeState

```ts
readonly treeState: TreeState<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:58

#### Accessors

<a id="disabled-2"></a>

##### disabled

###### Get Signature

```ts
get disabled(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:64

###### Returns

`boolean`

<a id="isexpanded"></a>

##### isExpanded

###### Get Signature

```ts
get isExpanded(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:63

###### Returns

`boolean`

<a id="isindeterminate"></a>

##### isIndeterminate

###### Get Signature

```ts
get isIndeterminate(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:65

###### Returns

`boolean`

<a id="isselected-2"></a>

##### isSelected

###### Get Signature

```ts
get isSelected(): boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:66

###### Returns

`boolean`

***

<a id="treestate-3"></a>

### TreeState

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:68

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Constructors

<a id="constructor-3"></a>

##### Constructor

```ts
new TreeState<TMetadata>(params): TreeState<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:86

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`TreeSelectStateProps`](/docs/api-reference/ui/build/tree-select.md#treeselectstateprops)\<`TMetadata`\> |

###### Returns

[`TreeState`](/docs/api-reference/ui/build/tree-select/tree-select-state.svelte.md#treestate-3)\<`TMetadata`\>

#### Properties

<a id="activenodeid"></a>

##### activeNodeId

```ts
activeNodeId: string | null;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:78

<a id="activerootindex"></a>

##### activeRootIndex

```ts
activeRootIndex: number;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:75

<a id="activerootnode"></a>

##### activeRootNode

```ts
activeRootNode: TreeParentNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:80

<a id="disablednodeids"></a>

##### disabledNodeIds

```ts
disabledNodeIds: SvelteSet<string>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:77

<a id="expandednodeids"></a>

##### expandedNodeIds

```ts
expandedNodeIds: SvelteSet<string>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:73

<a id="filtervalue"></a>

##### filterValue

```ts
filterValue: string;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:74

<a id="matchinfo"></a>

##### matchInfo

```ts
matchInfo: Map<string, {
  end: number;
  start: number;
}>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:82

<a id="multiple"></a>

##### multiple

```ts
readonly multiple: boolean;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:71

<a id="onchange"></a>

##### onChange?

```ts
readonly optional onChange?: (state) => void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:72

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | \{ `disabled`: readonly `string`[]; `selected`: readonly `string`[]; \} |
| `state.disabled` | readonly `string`[] |
| `state.selected` | readonly `string`[] |

###### Returns

`void`

<a id="rootnodes"></a>

##### rootNodes

```ts
readonly rootNodes: TreeParentNode<TMetadata>[];
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:70

<a id="selectednodeids"></a>

##### selectedNodeIds

```ts
selectedNodeIds: SvelteSet<string>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:76

<a id="visiblenodes"></a>

##### visibleNodes

```ts
visibleNodes: any[];
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:81

#### Methods

<a id="clearallselections"></a>

##### clearAllSelections()

```ts
clearAllSelections(): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:93

###### Returns

`void`

<a id="findnode"></a>

##### findNode()

```ts
findNode(nodeId): any;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:87

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodeId` | `string` |

###### Returns

`any`

<a id="notifychange"></a>

##### notifyChange()

```ts
notifyChange(): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:94

###### Returns

`void`

<a id="setactivenode"></a>

##### setActiveNode()

```ts
setActiveNode(nodeId): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:91

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodeId` | `string` \| `null` |

###### Returns

`void`

<a id="setactiverootindex"></a>

##### setActiveRootIndex()

```ts
setActiveRootIndex(index): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:92

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |

###### Returns

`void`

<a id="toggledisable"></a>

##### toggleDisable()

```ts
toggleDisable(nodeId): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:89

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodeId` | `string` |

###### Returns

`void`

<a id="toggleexpand"></a>

##### toggleExpand()

```ts
toggleExpand(nodeId): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:88

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodeId` | `string` |

###### Returns

`void`

<a id="toggleselection"></a>

##### toggleSelection()

```ts
toggleSelection(nodeId): void;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:90

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodeId` | `string` |

###### Returns

`void`

## Functions

<a id="isparentnode"></a>

### isParentNode()

```ts
function isParentNode<TMetadata>(node): node is TreeParentNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:3

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `node` | `any` |

#### Returns

`node is TreeParentNode<TMetadata>`

***

<a id="isrequiredchildnode"></a>

### isRequiredChildNode()

```ts
function isRequiredChildNode<TMetadata>(node): node is RequiredTreeChildNode<TMetadata>;
```

Defined in: packages/ui/build/tree-select/tree-select-state.svelte.d.ts:4

#### Type Parameters

| Type Parameter |
| ------ |
| `TMetadata` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `node` | `any` |

#### Returns

`node is RequiredTreeChildNode<TMetadata>`
