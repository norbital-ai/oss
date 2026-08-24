[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/page-header/page-header.svelte

# ui/build/page-header/page-header.svelte

## Interfaces

<a id="pageheaderprops"></a>

### PageHeaderProps

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:3

#### Extends

- `Omit`\<`HTMLAttributes`\<`HTMLElement`\>, `"children"`\>

#### Indexable

```ts
[key: symbol]: false | Attachment<HTMLElement> | null | undefined
```

```ts
[key: `data-${string}`]: any
```

#### Properties

<a id="actions"></a>

##### actions?

```ts
optional actions?: Snippet<[]>;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:8

<a id="description"></a>

##### description?

```ts
optional description?: string;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:6

<a id="eyebrow"></a>

##### eyebrow?

```ts
optional eyebrow?: string;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:7

<a id="title"></a>

##### title?

```ts
optional title?: string;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:5

Omit when the shell `AppMediaHeader` already shows app identity.

###### Overrides

```ts
Omit.title
```

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:10

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/page-header/page-header.svelte.d.ts:10
