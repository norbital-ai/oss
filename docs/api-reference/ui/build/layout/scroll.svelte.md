[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/scroll.svelte

# ui/build/layout/scroll.svelte

## Interfaces

<a id="scrollprops"></a>

### ScrollProps

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:4

#### Extends

- [`LayoutAttributes`](/docs/api-reference/ui/build/layout/layout.shared.md#layoutattributes)

#### Indexable

```ts
[key: symbol]: false | Attachment<HTMLDivElement> | null | undefined
```

```ts
[key: `data-${string}`]: any
```

#### Properties

<a id="align"></a>

##### align?

```ts
optional align?: "start" | "end" | "center" | "baseline" | "stretch";
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:19

<a id="as"></a>

##### as?

```ts
optional as?: LayoutElement;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:5

<a id="axis"></a>

##### axis?

```ts
optional axis?: ScrollAxis;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:6

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:26

<a id="fade"></a>

##### fade?

```ts
optional fade?: boolean;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:15

Fade the edges that have content beyond them. On by default: it is what tells a
reader there is more below now that the scroll bar hides at rest. Turn it off for a
region whose own content must stay at full opacity to its edge — a media surface, a
chart, anything where a soft edge would read as a rendering fault.

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:18

<a id="grow"></a>

##### grow?

```ts
optional grow?: boolean;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:22

Take the remaining space along the parent's main axis.

<a id="inset"></a>

##### inset?

```ts
optional inset?: boolean;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:8

<a id="justify"></a>

##### justify?

```ts
optional justify?: "start" | "end" | "center" | "between";
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:20

<a id="layout"></a>

##### layout?

```ts
optional layout?: ScrollLayout;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:17

Arrange direct children without introducing a second wrapper or scroll owner.

<a id="name"></a>

##### name

```ts
name: string;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:7

<a id="ref"></a>

##### ref?

```ts
optional ref?: HTMLElement | null;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:25

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:24

Allow this region to shrink when its parent is constrained.

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:28

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/scroll.svelte.d.ts:28
