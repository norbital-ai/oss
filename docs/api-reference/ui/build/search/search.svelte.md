[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/search/search.svelte

# ui/build/search/search.svelte

## Interfaces

<a id="searchprops"></a>

### SearchProps

Defined in: packages/ui/build/search/search.svelte.d.ts:1

#### Properties

<a id="appliedvalue"></a>

##### appliedValue?

```ts
optional appliedValue?: string;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:7

Shown on the trigger indicator when set; defaults to `value`.

<a id="commitonclose"></a>

##### commitOnClose?

```ts
optional commitOnClose?: boolean;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:16

When false, closing the popover without Enter reverts draft input via `onDismiss`.

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:14

<a id="indicatoranimated"></a>

##### indicatorAnimated?

```ts
optional indicatorAnimated?: boolean;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:12

<a id="indicatorposition"></a>

##### indicatorPosition?

```ts
optional indicatorPosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
```

Defined in: packages/ui/build/search/search.svelte.d.ts:11

<a id="indicatorsize"></a>

##### indicatorSize?

```ts
optional indicatorSize?: "sm" | "lg" | "md";
```

Defined in: packages/ui/build/search/search.svelte.d.ts:10

<a id="indicatorvariant"></a>

##### indicatorVariant?

```ts
optional indicatorVariant?: "info" | "default" | "success" | "warning" | "error";
```

Defined in: packages/ui/build/search/search.svelte.d.ts:9

<a id="oncommit"></a>

##### onCommit?

```ts
optional onCommit?: (value) => void;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:3

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="ondismiss"></a>

##### onDismiss?

```ts
optional onDismiss?: () => void;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:4

###### Returns

`void`

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (value) => void;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:2

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

###### Returns

`void`

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:8

<a id="showindicator"></a>

##### showIndicator?

```ts
optional showIndicator?: boolean;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:13

<a id="value"></a>

##### value

```ts
value: string;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:5

## Type Aliases

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:18

## Variables

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/search/search.svelte.d.ts:18
