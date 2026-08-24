[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/command/command-state.svelte

# ui/build/command/command-state.svelte

## Classes

<a id="commandstate"></a>

### CommandState

Defined in: packages/ui/build/command/command-state.svelte.d.ts:3

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CommandState(props): CommandState;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:30

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`CommandStateProps`](/docs/api-reference/ui/build/command/types.md#commandstateprops) |

###### Returns

[`CommandState`](/docs/api-reference/ui/build/command/command-state.svelte.md#commandstate)

#### Properties

<a id="filtervalue"></a>

##### filterValue

```ts
filterValue: string;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:7

<a id="indicatoritemvalue"></a>

##### indicatorItemValue

```ts
indicatorItemValue: string | null;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:6

<a id="inputmode"></a>

##### inputMode

```ts
inputMode: "keyboard" | "mouse";
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:8

<a id="isinputfocused"></a>

##### isInputFocused

```ts
isInputFocused: boolean;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:9

<a id="listref"></a>

##### listRef?

```ts
optional listRef?: HTMLElement;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:5

<a id="mouseinsidelist"></a>

##### mouseInsideList

```ts
mouseInsideList: boolean;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:10

<a id="resolvedindicatorvalue"></a>

##### resolvedIndicatorValue

```ts
resolvedIndicatorValue: string | null;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:22

<a id="visibleitems"></a>

##### visibleItems

```ts
visibleItems: object[];
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:11

###### Index Signature

```ts
[x: string]: unknown
```

###### description?

```ts
optional description?: string;
```

###### disabled?

```ts
optional disabled?: boolean;
```

###### groupId?

```ts
optional groupId?: string;
```

###### href?

```ts
optional href?: string;
```

###### keywords?

```ts
optional keywords?: readonly string[];
```

###### label?

```ts
optional label?: string;
```

###### value

```ts
value: string;
```

<a id="visibleitemssignature"></a>

##### visibleItemsSignature

```ts
visibleItemsSignature: string;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:21

#### Accessors

<a id="activevalues"></a>

##### activeValues

###### Get Signature

```ts
get activeValues(): string[];
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:25

###### Returns

`string`[]

<a id="columns"></a>

##### columns

###### Get Signature

```ts
get columns(): number | undefined;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:28

###### Returns

`number` \| `undefined`

<a id="filterfn"></a>

##### filterFn

###### Get Signature

```ts
get filterFn():
  | FilterFunction
  | undefined;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:27

###### Returns

  \| [`FilterFunction`](/docs/api-reference/ui/build/command/types.md#filterfunction)
  \| `undefined`

<a id="items"></a>

##### items

###### Get Signature

```ts
get items(): object[];
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:24

###### Returns

`object`[]

<a id="onchange"></a>

##### onChange

###### Get Signature

```ts
get onChange(): ((value) => void) | undefined;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:29

###### Returns

((`value`) => `void`) \| `undefined`

<a id="shouldfilter"></a>

##### shouldFilter

###### Get Signature

```ts
get shouldFilter(): boolean;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:26

###### Returns

`boolean`

<a id="shouldshowindicator"></a>

##### shouldShowIndicator

###### Get Signature

```ts
get shouldShowIndicator(): boolean;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:23

###### Returns

`boolean`

#### Methods

<a id="navigatedown"></a>

##### navigateDown()

```ts
navigateDown(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:35

###### Returns

`void`

<a id="navigatefirst"></a>

##### navigateFirst()

```ts
navigateFirst(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:39

###### Returns

`void`

<a id="navigatelast"></a>

##### navigateLast()

```ts
navigateLast(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:40

###### Returns

`void`

<a id="navigateleft"></a>

##### navigateLeft()

```ts
navigateLeft(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:38

###### Returns

`void`

<a id="navigateright"></a>

##### navigateRight()

```ts
navigateRight(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:37

###### Returns

`void`

<a id="navigateup"></a>

##### navigateUp()

```ts
navigateUp(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:36

###### Returns

`void`

<a id="selectcurrent"></a>

##### selectCurrent()

```ts
selectCurrent(): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:41

###### Returns

`void`

<a id="setfilter"></a>

##### setFilter()

```ts
setFilter(value): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:34

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="setindicator"></a>

##### setIndicator()

```ts
setIndicator(value): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:33

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` \| `null` |

###### Returns

`void`

<a id="setinputfocused"></a>

##### setInputFocused()

```ts
setInputFocused(isFocused): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:32

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `isFocused` | `boolean` |

###### Returns

`void`

<a id="setlistref"></a>

##### setListRef()

```ts
setListRef(element): void;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:31

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `element` | `HTMLElement` |

###### Returns

`void`

## Variables

<a id="getcommandstate"></a>

### getCommandState

```ts
const getCommandState: () => () => CommandState;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:2

#### Returns

() => [`CommandState`](/docs/api-reference/ui/build/command/command-state.svelte.md#commandstate)

***

<a id="setcommandstate"></a>

### setCommandState

```ts
const setCommandState: (context) => () => CommandState;
```

Defined in: packages/ui/build/command/command-state.svelte.d.ts:2

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => [`CommandState`](/docs/api-reference/ui/build/command/command-state.svelte.md#commandstate) |

#### Returns

() => [`CommandState`](/docs/api-reference/ui/build/command/command-state.svelte.md#commandstate)
