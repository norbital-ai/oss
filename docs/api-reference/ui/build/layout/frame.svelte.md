[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/frame.svelte

# ui/build/layout/frame.svelte

## Interfaces

<a id="frameprops"></a>

### FrameProps

Defined in: packages/ui/build/layout/frame.svelte.d.ts:5

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

Defined in: packages/ui/build/layout/frame.svelte.d.ts:6

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:10

<a id="ratio"></a>

##### ratio?

```ts
optional ratio?: FrameRatio;
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:7

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:9

Allow this region to shrink when its parent is constrained.

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:12

***

<a id="frameratio"></a>

### FrameRatio

```ts
type FrameRatio = "square" | "portrait" | "landscape" | "widescreen" | "banner";
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:4

Named media crops. `banner` is the compact overview / sheet hero (2:1).

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/frame.svelte.d.ts:12
