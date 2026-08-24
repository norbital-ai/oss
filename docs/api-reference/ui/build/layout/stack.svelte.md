[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/stack.svelte

# ui/build/layout/stack.svelte

## Interfaces

<a id="stackprops"></a>

### StackProps

Defined in: packages/ui/build/layout/stack.svelte.d.ts:3

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
optional align?: "start" | "end" | "center" | "stretch";
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:7

Cross-axis (horizontal) placement of the children.

<a id="as"></a>

##### as?

```ts
optional as?: LayoutElement;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:4

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:23

<a id="fill"></a>

##### fill?

```ts
optional fill?: boolean;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:20

Fill the parent's height, so `justify` has room to distribute.

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:5

<a id="grow"></a>

##### grow?

```ts
optional grow?: boolean;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:18

Take the remaining space along the parent's main axis.

<a id="justify"></a>

##### justify?

```ts
optional justify?: "start" | "end" | "center" | "between";
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:16

Main-axis (vertical) placement of the children.

Only meaningful when the Stack has more height than its content — inside a `Cover` body, a
`Bound size="full"`, or anything else that hands it a definite height. A Stack whose height
comes from its own content has nothing to distribute, which is why placing content against
a `min-h-*` parent silently does nothing and the content stays at the top. Pair with `fill`.

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:22

Allow this region to shrink when its parent is constrained.

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:25

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/stack.svelte.d.ts:25
