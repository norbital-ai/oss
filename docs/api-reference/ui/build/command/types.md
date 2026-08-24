[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/command/types

# ui/build/command/types

## Interfaces

<a id="commandclientconfig"></a>

### CommandClientConfig

Defined in: packages/ui/build/command/types.d.ts:16

#### Properties

<a id="error"></a>

##### error?

```ts
optional error?: string | null;
```

Defined in: packages/ui/build/command/types.d.ts:18

<a id="isloading"></a>

##### isLoading?

```ts
optional isLoading?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:17

***

<a id="commanddialogprops"></a>

### CommandDialogProps

Defined in: packages/ui/build/command/types.d.ts:116

#### Properties

<a id="children"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:120

<a id="onopenchange"></a>

##### onOpenChange?

```ts
optional onOpenChange?: (open) => void;
```

Defined in: packages/ui/build/command/types.d.ts:119

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `open` | `boolean` |

###### Returns

`void`

<a id="open"></a>

##### open?

```ts
optional open?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:117

<a id="value"></a>

##### value?

```ts
optional value?: string;
```

Defined in: packages/ui/build/command/types.d.ts:118

***

<a id="commandemptyprops"></a>

### CommandEmptyProps

Defined in: packages/ui/build/command/types.d.ts:107

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-1"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:108

###### Overrides

```ts
WithElementRef.children
```

<a id="show"></a>

##### show?

```ts
optional show?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:109

***

<a id="commandgroupheadingprops"></a>

### CommandGroupHeadingProps

Defined in: packages/ui/build/command/types.d.ts:92

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-2"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:93

###### Overrides

```ts
WithElementRef.children
```

***

<a id="commandgroupitemsprops"></a>

### CommandGroupItemsProps

Defined in: packages/ui/build/command/types.d.ts:95

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-3"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:96

###### Overrides

```ts
WithElementRef.children
```

***

<a id="commandgroupprops"></a>

### CommandGroupProps

Defined in: packages/ui/build/command/types.d.ts:88

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-4"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:90

###### Overrides

```ts
WithElementRef.children
```

<a id="heading"></a>

##### heading?

```ts
optional heading?: string;
```

Defined in: packages/ui/build/command/types.d.ts:89

***

<a id="commandinfiniteloadingconfig"></a>

### CommandInfiniteLoadingConfig

Defined in: packages/ui/build/command/types.d.ts:25

#### Properties

<a id="hasmore"></a>

##### hasMore

```ts
hasMore: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:27

<a id="onloadmore"></a>

##### onLoadMore

```ts
onLoadMore: (info) => void;
```

Defined in: packages/ui/build/command/types.d.ts:28

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `info` | \{ `lastVisibleIndex`: `number`; `loadedCount`: `number`; \} |
| `info.lastVisibleIndex` | `number` |
| `info.loadedCount` | `number` |

###### Returns

`void`

<a id="total"></a>

##### total

```ts
total: number;
```

Defined in: packages/ui/build/command/types.d.ts:26

***

<a id="commandinputprops"></a>

### CommandInputProps

Defined in: packages/ui/build/command/types.d.ts:98

#### Extends

- `WithElementRef`\<`Omit`\<`HTMLAttributes`\<`HTMLInputElement`\>, `"prefix"` \| `"aria-label"`\>\>

#### Indexable

```ts
[key: symbol]: false | Attachment<HTMLInputElement> | null | undefined
```

```ts
[key: `data-${string}`]: any
```

#### Properties

<a id="aria-label"></a>

##### aria-label?

```ts
optional aria-label?: string;
```

Defined in: packages/ui/build/command/types.d.ts:101

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:102

<a id="outerclass"></a>

##### outerClass?

```ts
optional outerClass?: string;
```

Defined in: packages/ui/build/command/types.d.ts:105

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/command/types.d.ts:100

###### Overrides

```ts
WithElementRef.placeholder
```

<a id="prefix"></a>

##### prefix?

```ts
optional prefix?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:103

<a id="suffix"></a>

##### suffix?

```ts
optional suffix?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:104

<a id="value-1"></a>

##### value?

```ts
optional value?: string;
```

Defined in: packages/ui/build/command/types.d.ts:99

***

<a id="commandlistprops"></a>

### CommandListProps

Defined in: packages/ui/build/command/types.d.ts:67

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-5"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:68

###### Overrides

```ts
WithElementRef.children
```

<a id="clientconfig"></a>

##### clientConfig?

```ts
optional clientConfig?: CommandClientConfig;
```

Defined in: packages/ui/build/command/types.d.ts:84

<a id="gap"></a>

##### gap?

```ts
optional gap?: number;
```

Defined in: packages/ui/build/command/types.d.ts:71

<a id="infiniteloading"></a>

##### infiniteLoading?

```ts
optional infiniteLoading?: CommandInfiniteLoadingConfig;
```

Defined in: packages/ui/build/command/types.d.ts:86

<a id="itemheight"></a>

##### itemHeight?

```ts
optional itemHeight?: number;
```

Defined in: packages/ui/build/command/types.d.ts:69

<a id="itemsnippet"></a>

##### itemSnippet?

```ts
optional itemSnippet?: Snippet<[{
  index: number;
  isIndicator: boolean;
  isSelected: boolean;
  item: {
   [key: string]: unknown;
     description?: string;
     disabled?: boolean;
     groupId?: string;
     href?: string;
     keywords?: readonly string[];
     label?: string;
     value: string;
  };
}]>;
```

Defined in: packages/ui/build/command/types.d.ts:72

<a id="loadmorethreshold"></a>

##### loadMoreThreshold?

```ts
optional loadMoreThreshold?: number;
```

Defined in: packages/ui/build/command/types.d.ts:83

<a id="overscan"></a>

##### overscan?

```ts
optional overscan?: number;
```

Defined in: packages/ui/build/command/types.d.ts:70

<a id="placeholdersnippet"></a>

##### placeholderSnippet?

```ts
optional placeholderSnippet?: Snippet<[{
  index: number;
}]>;
```

Defined in: packages/ui/build/command/types.d.ts:80

<a id="serverconfig"></a>

##### serverConfig?

```ts
optional serverConfig?: CommandServerConfig;
```

Defined in: packages/ui/build/command/types.d.ts:85

***

<a id="commandloadingprops"></a>

### CommandLoadingProps

Defined in: packages/ui/build/command/types.d.ts:113

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="children-6"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:114

###### Overrides

```ts
WithElementRef.children
```

***

<a id="commandrootprops"></a>

### CommandRootProps

Defined in: packages/ui/build/command/types.d.ts:51

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

#### Properties

<a id="activevalue"></a>

##### activeValue?

```ts
optional activeValue?: string;
```

Defined in: packages/ui/build/command/types.d.ts:54

<a id="children-7"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:64

###### Overrides

```ts
WithElementRef.children
```

<a id="columns"></a>

##### columns?

```ts
optional columns?: number;
```

Defined in: packages/ui/build/command/types.d.ts:58

<a id="disablenavigation"></a>

##### disableNavigation?

```ts
optional disableNavigation?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:65

<a id="filter"></a>

##### filter?

```ts
optional filter?: FilterFunction;
```

Defined in: packages/ui/build/command/types.d.ts:57

<a id="items"></a>

##### items?

```ts
optional items?: object[];
```

Defined in: packages/ui/build/command/types.d.ts:52

###### Index Signature

```ts
[key: string]: unknown
```

###### description?

```ts
readonly optional description?: string;
```

###### disabled?

```ts
readonly optional disabled?: boolean;
```

###### groupId?

```ts
readonly optional groupId?: string;
```

###### href?

```ts
readonly optional href?: string;
```

###### keywords?

```ts
readonly optional keywords?: readonly string[];
```

###### label?

```ts
readonly optional label?: string;
```

###### value

```ts
readonly value: string;
```

<a id="onindicatorkeydown"></a>

##### onIndicatorKeydown?

```ts
optional onIndicatorKeydown?: (event, context) => boolean | void;
```

Defined in: packages/ui/build/command/types.d.ts:60

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `KeyboardEvent` |
| `context` | \{ `indicatorValue`: `string` \| `null`; `items`: `object`[]; \} |
| `context.indicatorValue` | `string` \| `null` |
| `context.items` | `object`[] |

###### Returns

`boolean` \| `void`

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (value) => void;
```

Defined in: packages/ui/build/command/types.d.ts:59

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="searchvalue"></a>

##### searchValue?

```ts
optional searchValue?: string;
```

Defined in: packages/ui/build/command/types.d.ts:55

<a id="shouldfilter"></a>

##### shouldFilter?

```ts
optional shouldFilter?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:56

<a id="value-2"></a>

##### value?

```ts
optional value?: string | string[];
```

Defined in: packages/ui/build/command/types.d.ts:53

***

<a id="commandseparatorprops"></a>

### CommandSeparatorProps

Defined in: packages/ui/build/command/types.d.ts:111

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLDivElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

***

<a id="commandserverconfig"></a>

### CommandServerConfig

Defined in: packages/ui/build/command/types.d.ts:20

#### Properties

<a id="error-1"></a>

##### error?

```ts
optional error?: string | Error | null;
```

Defined in: packages/ui/build/command/types.d.ts:23

<a id="isloading-1"></a>

##### isLoading?

```ts
optional isLoading?: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:22

<a id="onsearch"></a>

##### onSearch

```ts
onSearch: (query) => void;
```

Defined in: packages/ui/build/command/types.d.ts:21

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query` | `string` |

###### Returns

`void`

***

<a id="commandshortcutprops"></a>

### CommandShortcutProps

Defined in: packages/ui/build/command/types.d.ts:122

#### Extends

- `WithElementRef`\<`HTMLAttributes`\<`HTMLSpanElement`\>\>

#### Indexable

```ts
[key: `data-${string}`]: any
```

```ts
[key: symbol]: false | Attachment<HTMLSpanElement> | null | undefined
```

#### Properties

<a id="children-8"></a>

##### children?

```ts
optional children?: Snippet<[]>;
```

Defined in: packages/ui/build/command/types.d.ts:123

###### Overrides

```ts
WithElementRef.children
```

***

<a id="commandstateprops"></a>

### CommandStateProps

Defined in: packages/ui/build/command/types.d.ts:41

#### Properties

<a id="activevalue-1"></a>

##### activeValue?

```ts
readonly optional activeValue?: string;
```

Defined in: packages/ui/build/command/types.d.ts:45

<a id="columns-1"></a>

##### columns?

```ts
optional columns?: number;
```

Defined in: packages/ui/build/command/types.d.ts:48

<a id="filterfn"></a>

##### filterFn?

```ts
optional filterFn?: FilterFunction;
```

Defined in: packages/ui/build/command/types.d.ts:47

<a id="items-1"></a>

##### items?

```ts
readonly optional items?: object[];
```

Defined in: packages/ui/build/command/types.d.ts:42

###### Index Signature

```ts
[key: string]: unknown
```

###### description?

```ts
readonly optional description?: string;
```

###### disabled?

```ts
readonly optional disabled?: boolean;
```

###### groupId?

```ts
readonly optional groupId?: string;
```

###### href?

```ts
readonly optional href?: string;
```

###### keywords?

```ts
readonly optional keywords?: readonly string[];
```

###### label?

```ts
readonly optional label?: string;
```

###### value

```ts
readonly value: string;
```

<a id="onchange"></a>

##### onChange?

```ts
optional onChange?: (value) => void;
```

Defined in: packages/ui/build/command/types.d.ts:49

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="searchvalue-1"></a>

##### searchValue?

```ts
readonly optional searchValue?: string;
```

Defined in: packages/ui/build/command/types.d.ts:43

<a id="shouldfilter-1"></a>

##### shouldFilter

```ts
shouldFilter: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:46

<a id="value-3"></a>

##### value?

```ts
readonly optional value?: string | string[];
```

Defined in: packages/ui/build/command/types.d.ts:44

***

<a id="tinfiniteloadingconfig"></a>

### TInfiniteLoadingConfig

Defined in: packages/ui/build/command/types.d.ts:33

#### Properties

<a id="handleinfiniteload"></a>

##### handleInfiniteLoad

```ts
handleInfiniteLoad: (info) => void;
```

Defined in: packages/ui/build/command/types.d.ts:36

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `info` | \{ `lastVirtualIndex`: `number`; `loadedCount`: `number`; \} |
| `info.lastVirtualIndex` | `number` |
| `info.loadedCount` | `number` |

###### Returns

`void`

<a id="hasmore-1"></a>

##### hasMore

```ts
hasMore: boolean;
```

Defined in: packages/ui/build/command/types.d.ts:35

<a id="total-1"></a>

##### total

```ts
total: number;
```

Defined in: packages/ui/build/command/types.d.ts:34

## Type Aliases

<a id="commanditemdata"></a>

### CommandItemData

```ts
type CommandItemData = typeof CommandItemDataSchema.Type;
```

Defined in: packages/ui/build/command/types.d.ts:14

***

<a id="filterfunction"></a>

### FilterFunction

```ts
type FilterFunction = (value, search, keywords?) => number;
```

Defined in: packages/ui/build/command/types.d.ts:15

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `search` | `string` |
| `keywords?` | readonly `string`[] |

#### Returns

`number`
