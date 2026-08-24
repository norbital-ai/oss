[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/split.svelte

# ui/build/layout/split.svelte

## Interfaces

<a id="splitprops"></a>

### SplitProps

Defined in: packages/ui/build/layout/split.svelte.d.ts:5

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

Defined in: packages/ui/build/layout/split.svelte.d.ts:6

<a id="collapse"></a>

##### collapse?

```ts
optional collapse?: SplitCollapse;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:8

<a id="collapseat"></a>

##### collapseAt?

```ts
optional collapseAt?: "compact" | "narrow";
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:9

<a id="end"></a>

##### end

```ts
end: Snippet;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:14

<a id="fill"></a>

##### fill?

```ts
optional fill?: boolean;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:12

Fill a definite-height parent so both panes can hand that height to their contents.

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:10

<a id="ratio"></a>

##### ratio?

```ts
optional ratio?: SplitRatio;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:7

<a id="start"></a>

##### start

```ts
start: Snippet;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:13

<a id="switchlabels"></a>

##### switchLabels?

```ts
optional switchLabels?: readonly [string, string];
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:15

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:17

***

<a id="splitcollapse"></a>

### SplitCollapse

```ts
type SplitCollapse = "stack" | "switch" | "none";
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:4

***

<a id="splitratio"></a>

### SplitRatio

```ts
type SplitRatio = "rail" | "sidebar" | "third" | "half" | "wide";
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:3

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/split.svelte.d.ts:17
