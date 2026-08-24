[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/column.svelte

# ui/build/layout/column.svelte

## Interfaces

<a id="columnprops"></a>

### ColumnProps

Defined in: packages/ui/build/layout/column.svelte.d.ts:4

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

Defined in: packages/ui/build/layout/column.svelte.d.ts:5

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/column.svelte.d.ts:7

<a id="span"></a>

##### span?

```ts
optional span?: ColumnSpan;
```

Defined in: packages/ui/build/layout/column.svelte.d.ts:6

## Type Aliases

<a id="columnspan"></a>

### ColumnSpan

```ts
type ColumnSpan = 1 | 2 | 3 | 4 | 5 | 6 | "all";
```

Defined in: packages/ui/build/layout/column.svelte.d.ts:3

***

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/column.svelte.d.ts:9

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/column.svelte.d.ts:9
