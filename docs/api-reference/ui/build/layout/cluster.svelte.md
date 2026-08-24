[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/cluster.svelte

# ui/build/layout/cluster.svelte

## Interfaces

<a id="clusterprops"></a>

### ClusterProps

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:3

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
optional align?: "start" | "end" | "center" | "baseline";
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:6

<a id="as"></a>

##### as?

```ts
optional as?: LayoutElement;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:4

<a id="children"></a>

##### children

```ts
children: Snippet;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:14

<a id="fill"></a>

##### fill?

```ts
optional fill?: boolean;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:11

Fill the parent's height.

<a id="gap"></a>

##### gap?

```ts
optional gap?: LayoutGap;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:5

<a id="grow"></a>

##### grow?

```ts
optional grow?: boolean;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:9

Take the remaining space along the parent's main axis.

<a id="justify"></a>

##### justify?

```ts
optional justify?: "start" | "end" | "center" | "between";
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:7

<a id="shrink"></a>

##### shrink?

```ts
optional shrink?: boolean;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:13

Allow this region to shrink when its parent is constrained.

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:16

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/layout/cluster.svelte.d.ts:16
