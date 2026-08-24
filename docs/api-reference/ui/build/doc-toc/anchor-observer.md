[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/doc-toc/anchor-observer

# ui/build/doc-toc/anchor-observer

## Classes

<a id="doctocanchorobserver"></a>

### DocTocAnchorObserver

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:6

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new DocTocAnchorObserver(): DocTocAnchorObserver;
```

###### Returns

[`DocTocAnchorObserver`](/docs/api-reference/ui/build/doc-toc/anchor-observer.md#doctocanchorobserver)

#### Properties

<a id="items"></a>

##### items

```ts
items: object[];
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:7

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

#### Methods

<a id="listen"></a>

##### listen()

```ts
listen(listener): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:14

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `listener` | `DocTocChangeListener` |

###### Returns

`void`

<a id="setitems"></a>

##### setItems()

```ts
setItems(newItems): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:16

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `newItems` | `object`[] |

###### Returns

`void`

<a id="unlisten"></a>

##### unlisten()

```ts
unlisten(listener): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:15

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `listener` | `DocTocChangeListener` |

###### Returns

`void`

<a id="unwatch"></a>

##### unwatch()

```ts
unwatch(): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:18

###### Returns

`void`

<a id="watch"></a>

##### watch()

```ts
watch(options?): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:17

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | `IntersectionObserverInit` |

###### Returns

`void`

## Functions

<a id="builddoctocrootmargin"></a>

### buildDocTocRootMargin()

```ts
function buildDocTocRootMargin(topRem?, bottomPercent?): string;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:4

IntersectionObserver rootMargin only accepts px or % — not rem.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `topRem?` | `number` |
| `bottomPercent?` | `number` |

#### Returns

`string`

***

<a id="computedoctoctrackbounds"></a>

### computeDocTocTrackBounds()

```ts
function computeDocTocTrackBounds(positions, items):
  | {
  bottom: number;
  top: number;
}
  | null;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:35

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `positions` | (\[`number`, `number`\] \| `null`)[] |
| `items` | `object`[] |

#### Returns

  \| \{
  `bottom`: `number`;
  `top`: `number`;
\}
  \| `null`

***

<a id="findlastactiveindex"></a>

### findLastActiveIndex()

```ts
function findLastActiveIndex(items): number;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:5

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `items` | `object`[] |

#### Returns

`number`

***

<a id="getactivedoctocitem"></a>

### getActiveDocTocItem()

```ts
function getActiveDocTocItem(items):
  | {
  active: boolean;
  fallback: boolean;
  id: string;
  original: {
     depth: number;
     title: string;
     url: string;
  };
  t: number;
}
  | undefined;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:34

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `items` | `object`[] |

#### Returns

  \| \{
  `active`: `boolean`;
  `fallback`: `boolean`;
  `id`: `string`;
  `original`: \{
     `depth`: `number`;
     `title`: `string`;
     `url`: `string`;
  \};
  `t`: `number`;
\}
  \| `undefined`

***

<a id="scrolldoctoclinkintoview"></a>

### scrollDocTocLinkIntoView()

```ts
function scrollDocTocLinkIntoView(link, container): void;
```

Defined in: packages/ui/build/doc-toc/anchor-observer.d.ts:36

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `link` | `HTMLElement` |
| `container` | `HTMLElement` |

#### Returns

`void`
