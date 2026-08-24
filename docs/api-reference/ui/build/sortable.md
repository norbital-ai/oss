[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/sortable

# ui/build/sortable

## Interfaces

<a id="sortableitemprops"></a>

### SortableItemProps

Defined in: packages/ui/build/sortable/index.d.ts:7

#### Properties

<a id="child"></a>

##### child

```ts
child: Snippet<[{
  props: {
     class: string;
     data-sortable-disabled: string | undefined;
     data-sortable-id: string;
     isDragging: boolean;
  };
}]>;
```

Defined in: packages/ui/build/sortable/index.d.ts:11

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:10

<a id="id"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/sortable/index.d.ts:8

<a id="isdragging"></a>

##### isDragging

```ts
isDragging: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:9

***

<a id="sortablerootprops"></a>

### SortableRootProps

Defined in: packages/ui/build/sortable/index.d.ts:44

Root props (headless).

IMPORTANT:
- `items` must be stable string IDs in display order.
- `onSort` emits the new order as primitive IDs.
- `element` is the caller-owned SortableJS target.

#### Properties

<a id="child-1"></a>

##### child

```ts
child: Snippet<[{
  draggedItemId: string | null;
  sortedItems: string[];
}]>;
```

Defined in: packages/ui/build/sortable/index.d.ts:64

<a id="delay"></a>

##### delay?

```ts
optional delay?: number;
```

Defined in: packages/ui/build/sortable/index.d.ts:57

<a id="delayontouchonly"></a>

##### delayOnTouchOnly?

```ts
optional delayOnTouchOnly?: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:58

<a id="direction"></a>

##### direction?

```ts
optional direction?: "vertical" | "horizontal";
```

Defined in: packages/ui/build/sortable/index.d.ts:47

<a id="disabled-1"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:56

<a id="element"></a>

##### element

```ts
element: HTMLElement | null;
```

Defined in: packages/ui/build/sortable/index.d.ts:45

<a id="fallbacktolerance"></a>

##### fallbackTolerance?

```ts
optional fallbackTolerance?: number;
```

Defined in: packages/ui/build/sortable/index.d.ts:60

<a id="ghostclass"></a>

##### ghostClass?

```ts
optional ghostClass?: string;
```

Defined in: packages/ui/build/sortable/index.d.ts:48

<a id="handle"></a>

##### handle?

```ts
optional handle?: string;
```

Defined in: packages/ui/build/sortable/index.d.ts:49

<a id="items"></a>

##### items

```ts
items: string[];
```

Defined in: packages/ui/build/sortable/index.d.ts:46

<a id="ondragend"></a>

##### onDragEnd?

```ts
optional onDragEnd?: (evt) => void;
```

Defined in: packages/ui/build/sortable/index.d.ts:55

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `evt` | `SortableEvent` |

###### Returns

`void`

<a id="ondragstart"></a>

##### onDragStart?

```ts
optional onDragStart?: (id, evt) => void;
```

Defined in: packages/ui/build/sortable/index.d.ts:54

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `id` | `string` |
| `evt` | `SortableEvent` |

###### Returns

`void`

<a id="onsort"></a>

##### onSort?

```ts
optional onSort?: (orderedIds, evt) => void;
```

Defined in: packages/ui/build/sortable/index.d.ts:53

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `orderedIds` | `string`[] |
| `evt` | `SortableEvent` |

###### Returns

`void`

<a id="scroll"></a>

##### scroll?

```ts
optional scroll?: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:61

<a id="scrollsensitivity"></a>

##### scrollSensitivity?

```ts
optional scrollSensitivity?: number;
```

Defined in: packages/ui/build/sortable/index.d.ts:62

<a id="scrollspeed"></a>

##### scrollSpeed?

```ts
optional scrollSpeed?: number;
```

Defined in: packages/ui/build/sortable/index.d.ts:63

<a id="sort"></a>

##### sort?

```ts
optional sort?: boolean;
```

Defined in: packages/ui/build/sortable/index.d.ts:52

<a id="sortablegroup"></a>

##### sortableGroup?

```ts
optional sortableGroup?: string | GroupOptions;
```

Defined in: packages/ui/build/sortable/index.d.ts:51

SortableJS `group` option (renamed to avoid Svelte `{group}` shorthand collisions).

<a id="touchstartthreshold"></a>

##### touchStartThreshold?

```ts
optional touchStartThreshold?: number;
```

Defined in: packages/ui/build/sortable/index.d.ts:59

## Type Aliases

<a id="sortablegroupoption"></a>

### SortableGroupOption

```ts
type SortableGroupOption =
  | string
  | {
  name: string;
  pull?: boolean | "clone" | ((to, from) => boolean | string);
  put?: boolean | string[] | ((to, from) => boolean);
  revertClone?: boolean;
};
```

Defined in: packages/ui/build/sortable/index.d.ts:30

SortableJS group option type — extracted from SortableJS definitions.
Keep broad for flexibility; narrow in your codebase if needed.

## Variables

<a id="sortable"></a>

### Sortable

```ts
const Sortable: object;
```

Defined in: packages/ui/build/sortable/index.d.ts:3

#### Type Declaration

<a id="item"></a>

##### Item

```ts
Item: Component;
```

<a id="root"></a>

##### Root

```ts
Root: Component;
```
