[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/carousel/context

# ui/build/carousel/context

## Type Aliases

<a id="carouselapi"></a>

### CarouselAPI

```ts
type CarouselAPI = NonNullable<NonNullable<EmblaCarouselSvelteType["$$_attributes"]>["on:emblaInit"]> extends (evt) => void ? CarouselAPI : never;
```

Defined in: packages/ui/build/carousel/context.d.ts:5

***

<a id="carouselprops"></a>

### CarouselProps

```ts
type CarouselProps = object & WithElementRef<HTMLAttributes<HTMLDivElement>>;
```

Defined in: packages/ui/build/carousel/context.d.ts:9

#### Type Declaration

##### opts?

```ts
optional opts?: CarouselOptions;
```

##### orientation?

```ts
optional orientation?: "horizontal" | "vertical";
```

##### plugins?

```ts
optional plugins?: any[];
```

##### setApi?

```ts
optional setApi?: (api) => void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `api` | \| [`CarouselAPI`](/docs/api-reference/ui/build/carousel/context.md#carouselapi) \| `undefined` |

###### Returns

`void`

***

<a id="emblacontext"></a>

### EmblaContext

```ts
type EmblaContext = object;
```

Defined in: packages/ui/build/carousel/context.d.ts:15

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-api"></a> `api` | \| [`CarouselAPI`](/docs/api-reference/ui/build/carousel/context.md#carouselapi) \| `undefined` | packages/ui/build/carousel/context.d.ts:16 |
| <a id="property-canscrollnext"></a> `canScrollNext` | `boolean` | packages/ui/build/carousel/context.d.ts:20 |
| <a id="property-canscrollprev"></a> `canScrollPrev` | `boolean` | packages/ui/build/carousel/context.d.ts:21 |
| <a id="property-handlekeydown"></a> `handleKeyDown` | (`e`) => `void` | packages/ui/build/carousel/context.d.ts:22 |
| <a id="property-oninit"></a> `onInit` | (`e`) => `void` | packages/ui/build/carousel/context.d.ts:25 |
| <a id="property-options"></a> `options` | `CarouselOptions` | packages/ui/build/carousel/context.d.ts:23 |
| <a id="property-orientation"></a> `orientation` | `"horizontal"` \| `"vertical"` | packages/ui/build/carousel/context.d.ts:17 |
| <a id="property-plugins"></a> `plugins` | `any`[] | packages/ui/build/carousel/context.d.ts:24 |
| <a id="property-scrollnext"></a> `scrollNext` | () => `void` | packages/ui/build/carousel/context.d.ts:18 |
| <a id="property-scrollprev"></a> `scrollPrev` | () => `void` | packages/ui/build/carousel/context.d.ts:19 |
| <a id="property-scrollsnaps"></a> `scrollSnaps` | `number`[] | packages/ui/build/carousel/context.d.ts:27 |
| <a id="property-scrollto"></a> `scrollTo` | (`index`, `jump?`) => `void` | packages/ui/build/carousel/context.d.ts:26 |
| <a id="property-selectedindex"></a> `selectedIndex` | `number` | packages/ui/build/carousel/context.d.ts:28 |

## Variables

<a id="setemblacontext"></a>

### setEmblaContext

```ts
const setEmblaContext: (context) => () => EmblaContext;
```

Defined in: packages/ui/build/carousel/context.d.ts:30

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => [`EmblaContext`](/docs/api-reference/ui/build/carousel/context.md#emblacontext) |

#### Returns

() => [`EmblaContext`](/docs/api-reference/ui/build/carousel/context.md#emblacontext)

## Functions

<a id="getemblacontext"></a>

### getEmblaContext()

```ts
function getEmblaContext(name?): () => EmblaContext;
```

Defined in: packages/ui/build/carousel/context.d.ts:32

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name?` | `string` |

#### Returns

() => [`EmblaContext`](/docs/api-reference/ui/build/carousel/context.md#emblacontext)
