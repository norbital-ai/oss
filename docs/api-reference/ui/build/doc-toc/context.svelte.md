[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/doc-toc/context.svelte

# ui/build/doc-toc/context.svelte

## Classes

<a id="doctocstate"></a>

### DocTocState

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:3

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new DocTocState(): DocTocState;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:21

###### Returns

[`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate)

#### Properties

<a id="items"></a>

##### items

```ts
items: object[];
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:5

###### depth

```ts
readonly depth: number;
```

###### title

```ts
readonly title: string;
```

###### url

```ts
readonly url: string;
```

<a id="observeditems"></a>

##### observedItems

```ts
observedItems: object[];
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:10

###### active

```ts
readonly active: boolean;
```

###### fallback

```ts
readonly fallback: boolean;
```

###### id

```ts
readonly id: string;
```

###### original

```ts
readonly original: object;
```

###### original.depth

```ts
readonly depth: number;
```

###### original.title

```ts
readonly title: string;
```

###### original.url

```ts
readonly url: string;
```

###### t

```ts
readonly t: number;
```

<a id="observer"></a>

##### observer

```ts
readonly observer: DocTocAnchorObserver;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:4

#### Methods

<a id="setitems"></a>

##### setItems()

```ts
setItems(next): void;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:22

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `next` | `object`[] |

###### Returns

`void`

## Variables

<a id="getdoctocstate"></a>

### getDocTocState

```ts
const getDocTocState: () => () => DocTocState;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:24

#### Returns

() => [`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate)

***

<a id="setdoctocstatecontext"></a>

### setDocTocStateContext

```ts
const setDocTocStateContext: (context) => () => DocTocState;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:24

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => [`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate) |

#### Returns

() => [`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate)

## Functions

<a id="setdoctocstate"></a>

### setDocTocState()

```ts
function setDocTocState(state): DocTocState;
```

Defined in: packages/ui/build/doc-toc/context.svelte.d.ts:25

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | [`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate) |

#### Returns

[`DocTocState`](/docs/api-reference/ui/build/doc-toc/context.svelte.md#doctocstate)
