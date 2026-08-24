[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/cover.svelte

# ui/build/layout/cover.svelte

## Interfaces

<a id="coverprops"></a>

### CoverProps

Defined in: packages/ui/build/layout/cover.svelte.d.ts:3

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

Defined in: packages/ui/build/layout/cover.svelte.d.ts:4

<a id="bottom"></a>

##### bottom?

```ts
optional bottom?: Snippet<[]>;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:12

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:13

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:5

<a id="grow"></a>

##### grow?

```ts
optional grow?: boolean;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:8

Take the remaining space along the parent's main axis.

<a id="pad"></a>

##### pad?

```ts
optional pad?: LayoutPad;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:6

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:10

Allow this region to shrink when its parent is constrained.

<a id="top"></a>

##### top?

```ts
optional top?: Snippet<[]>;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:11

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:15

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/cover.svelte.d.ts:15
