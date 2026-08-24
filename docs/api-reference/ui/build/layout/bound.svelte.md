[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/bound.svelte

# ui/build/layout/bound.svelte

## Interfaces

<a id="boundprops"></a>

### BoundProps

Defined in: packages/ui/build/layout/bound.svelte.d.ts:4

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

<a id="as"></a>

##### as?

```ts
optional as?: LayoutElement;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:5

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:20

<a id="clip"></a>

##### clip?

```ts
optional clip?: boolean;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:15

<a id="grow"></a>

##### grow?

```ts
optional grow?: boolean;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:17

Take the remaining space along the parent's main axis.

<a id="inset"></a>

##### inset?

```ts
optional inset?: boolean;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:14

<a id="pad"></a>

##### pad?

```ts
optional pad?: LayoutPad;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:13

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:19

Allow this region to shrink when its parent is constrained.

<a id="size"></a>

##### size?

```ts
optional size?: BoundSize;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:12

The named height contract. `compact`/`standard`/`tall` are fixed panes;
`fit` tracks the viewer: `min(42rem, 100dvh − 14rem)` with a `standard` floor, so a
scrollport claims the space below a ~14rem chrome band instead of guessing a pane size;
`full` fills whatever definite height the parent grants.

## Type Aliases

<a id="boundsize"></a>

### BoundSize

```ts
type BoundSize = "compact" | "standard" | "tall" | "fit" | "full";
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:3

***

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:22

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/bound.svelte.d.ts:22
