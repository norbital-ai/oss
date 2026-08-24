[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/utils/virtualizer.svelte

# ui/build/utils/virtualizer.svelte

## Interfaces

<a id="scrolltoindexoptions"></a>

### ScrollToIndexOptions

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:36

#### Properties

<a id="align"></a>

##### align?

```ts
optional align?: ScrollAlignment;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:37

<a id="behavior"></a>

##### behavior?

```ts
optional behavior?: ScrollBehavior;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:38

***

<a id="scrolltooffsetoptions"></a>

### ScrollToOffsetOptions

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:40

#### Properties

<a id="behavior-1"></a>

##### behavior?

```ts
optional behavior?: ScrollBehavior;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:41

***

<a id="virtualitem"></a>

### VirtualItem

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:6

Svelte 5 Runes-based Virtualizer

A lightweight virtualizer using runed primitives and small inlined helpers (e.g. sorted-index binary search).

#### Properties

<a id="end"></a>

##### end

```ts
end: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:10

<a id="index"></a>

##### index

```ts
index: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:7

<a id="key"></a>

##### key

```ts
key: string | number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:8

<a id="size"></a>

##### size

```ts
size: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:11

<a id="start"></a>

##### start

```ts
start: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:9

***

<a id="virtualizer"></a>

### Virtualizer

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:24

#### Properties

<a id="getoffsetforindex"></a>

##### getOffsetForIndex

```ts
getOffsetForIndex: (index, align?) => number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:32

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |
| `align?` | [`ScrollAlignment`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrollalignment) |

###### Returns

`number`

<a id="gettotalsize"></a>

##### getTotalSize

```ts
getTotalSize: () => number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:34

###### Returns

`number`

<a id="getvirtualitems"></a>

##### getVirtualItems

```ts
getVirtualItems: () => VirtualItem[];
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:33

###### Returns

[`VirtualItem`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualitem)[]

<a id="measure"></a>

##### measure

```ts
measure: () => void;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:30

###### Returns

`void`

<a id="measureelement"></a>

##### measureElement

```ts
measureElement: (element) => void;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:31

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `element` | `HTMLElement` \| `null` |

###### Returns

`void`

<a id="scrolloffset"></a>

##### scrollOffset

```ts
readonly scrollOffset: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:27

<a id="scrolltoindex"></a>

##### scrollToIndex

```ts
scrollToIndex: (index, options?) => void;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:28

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |
| `options?` | [`ScrollToIndexOptions`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrolltoindexoptions) |

###### Returns

`void`

<a id="scrolltooffset"></a>

##### scrollToOffset

```ts
scrollToOffset: (offset, options?) => void;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:29

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `offset` | `number` |
| `options?` | [`ScrollToOffsetOptions`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrolltooffsetoptions) |

###### Returns

`void`

<a id="totalsize"></a>

##### totalSize

```ts
readonly totalSize: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:26

<a id="virtualitems"></a>

##### virtualItems

```ts
readonly virtualItems: VirtualItem[];
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:25

***

<a id="virtualizeroptions"></a>

### VirtualizerOptions

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:13

#### Properties

<a id="count"></a>

##### count

```ts
count: () => number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:14

###### Returns

`number`

<a id="estimatesize"></a>

##### estimateSize

```ts
estimateSize: (index) => number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:16

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |

###### Returns

`number`

<a id="getitemkey"></a>

##### getItemKey?

```ts
optional getItemKey?: (index) => string | number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:19

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `index` | `number` |

###### Returns

`string` \| `number`

<a id="horizontal"></a>

##### horizontal?

```ts
optional horizontal?: boolean;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:18

<a id="indexattribute"></a>

##### indexAttribute?

```ts
optional indexAttribute?: string;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:22

<a id="initialoffset"></a>

##### initialOffset?

```ts
optional initialOffset?: number;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:21

<a id="onchange"></a>

##### onChange?

```ts
optional onChange?: (virtualizer) => void;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:20

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `virtualizer` | [`Virtualizer`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualizer) |

###### Returns

`void`

<a id="overscan"></a>

##### overscan?

```ts
optional overscan?: number | (() => number);
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:17

<a id="scrollelement"></a>

##### scrollElement

```ts
scrollElement: () => HTMLElement | null;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:15

###### Returns

`HTMLElement` \| `null`

## Type Aliases

<a id="scrollalignment"></a>

### ScrollAlignment

```ts
type ScrollAlignment = "start" | "center" | "end" | "auto";
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:43

## Functions

<a id="createvirtualizer"></a>

### createVirtualizer()

```ts
function createVirtualizer(options): Virtualizer;
```

Defined in: packages/ui/build/utils/virtualizer.svelte.d.ts:44

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`VirtualizerOptions`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualizeroptions) |

#### Returns

[`Virtualizer`](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualizer)
