[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/center.svelte

# ui/build/layout/center.svelte

## Interfaces

<a id="centerprops"></a>

### CenterProps

Defined in: packages/ui/build/layout/center.svelte.d.ts:5

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

Defined in: packages/ui/build/layout/center.svelte.d.ts:11

<a id="as"></a>

##### as?

```ts
optional as?: LayoutElement;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:6

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:13

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:10

<a id="justify"></a>

##### justify?

```ts
optional justify?: "start" | "end" | "center" | "between";
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:12

<a id="layout"></a>

##### layout?

```ts
optional layout?: CenterLayout;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:9

Arrange direct children while keeping centring and composition on the same element.

<a id="measure"></a>

##### measure?

```ts
optional measure?: CenterMeasure;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:7

## Type Aliases

<a id="centermeasure"></a>

### CenterMeasure

```ts
type CenterMeasure = "narrow" | "reading" | "wide" | "full";
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:3

***

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:15

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/center.svelte.d.ts:15
