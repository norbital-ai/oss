[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/grid.svelte

# ui/build/layout/grid.svelte

## Interfaces

<a id="gridprops"></a>

### GridProps

Defined in: packages/ui/build/layout/grid.svelte.d.ts:4

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

Defined in: packages/ui/build/layout/grid.svelte.d.ts:5

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:14

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:6

<a id="minimum"></a>

##### minimum?

```ts
optional minimum?: GridMinimum;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:7

<a id="tracks"></a>

##### tracks?

```ts
optional tracks?: string;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:13

Explicit column tracks. When set, this is the grid template (via `style`, not a Tailwind
class) and `minimum` is ignored. Use `minimum` for intrinsic auto-fit cards; use `tracks`
when the columns are a known, uneven measure — a log table, a definition list.

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:16

***

<a id="gridminimum"></a>

### GridMinimum

```ts
type GridMinimum = "compact" | "card" | "panel";
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:3

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/grid.svelte.d.ts:16
