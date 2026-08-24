[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/columns.svelte

# ui/build/layout/columns.svelte

## Interfaces

<a id="columnsprops"></a>

### ColumnsProps

Defined in: packages/ui/build/layout/columns.svelte.d.ts:4

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

Defined in: packages/ui/build/layout/columns.svelte.d.ts:5

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:8

<a id="count"></a>

##### count?

```ts
optional count?: ColumnCount;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:6

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:7

## Type Aliases

<a id="columncount"></a>

### ColumnCount

```ts
type ColumnCount = 2 | 3 | 4 | 6;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:3

***

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:10

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/columns.svelte.d.ts:10
