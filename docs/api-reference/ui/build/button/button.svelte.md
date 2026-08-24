[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/button/button.svelte

# ui/build/button/button.svelte

## Type Aliases

<a id="buttonprops"></a>

### ButtonProps

```ts
type ButtonProps = WithElementRef<HTMLButtonAttributes> & WithElementRef<HTMLAnchorAttributes> & object;
```

Defined in: packages/ui/build/button/button.svelte.d.ts:52

#### Type Declaration

##### disabledMessage?

```ts
optional disabledMessage?: string;
```

##### hint?

```ts
optional hint?: string;
```

##### readonly?

```ts
optional readonly?: boolean;
```

##### readonlyMessage?

```ts
optional readonlyMessage?: string;
```

##### size?

```ts
optional size?: ButtonSize;
```

##### variant?

```ts
optional variant?: ButtonVariant;
```

***

<a id="buttonsize"></a>

### ButtonSize

```ts
type ButtonSize = VariantProps<typeof buttonVariants>["size"];
```

Defined in: packages/ui/build/button/button.svelte.d.ts:51

***

<a id="buttonvariant"></a>

### ButtonVariant

```ts
type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
```

Defined in: packages/ui/build/button/button.svelte.d.ts:50

***

<a id="default"></a>

### default

```ts
type default = ReturnType<typeof default>;
```

Defined in: packages/ui/build/button/button.svelte.d.ts:60

## Variables

<a id="buttonvariants"></a>

### buttonVariants

```ts
const buttonVariants: TVReturnType;
```

Defined in: packages/ui/build/button/button.svelte.d.ts:4

***

<a id="default-1"></a>

### default

```ts
const default: Component;
```

Defined in: packages/ui/build/button/button.svelte.d.ts:60
