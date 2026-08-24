[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/sliding-indicator/sliding-indicator

# ui/build/sliding-indicator/sliding-indicator

## Type Aliases

<a id="slidingindicatorpositioned"></a>

### SlidingIndicatorPositioned

```ts
type SlidingIndicatorPositioned = object;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:18

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-current"></a> `current` | `boolean` | packages/ui/build/sliding-indicator/sliding-indicator.d.ts:19 |

***

<a id="slidingindicatorrect"></a>

### SlidingIndicatorRect

```ts
type SlidingIndicatorRect = object;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:7

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-height"></a> `height` | `number` | packages/ui/build/sliding-indicator/sliding-indicator.d.ts:11 |
| <a id="property-width"></a> `width` | `number` | packages/ui/build/sliding-indicator/sliding-indicator.d.ts:10 |
| <a id="property-x"></a> `x` | `number` | packages/ui/build/sliding-indicator/sliding-indicator.d.ts:8 |
| <a id="property-y"></a> `y` | `number` | packages/ui/build/sliding-indicator/sliding-indicator.d.ts:9 |

## Variables

<a id="sliding_indicator_expand_transition_class"></a>

### SLIDING\_INDICATOR\_EXPAND\_TRANSITION\_CLASS

```ts
const SLIDING_INDICATOR_EXPAND_TRANSITION_CLASS: "grid min-h-0 transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]" = "grid min-h-0 transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]";
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:6

Folder expand/collapse in file tree — same duration and easing.

***

<a id="sliding_indicator_ms"></a>

### SLIDING\_INDICATOR\_MS

```ts
const SLIDING_INDICATOR_MS: 200 = 200;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:2

Shared duration for sliding selection indicators (tabs, file tree, sidebar rail).

***

<a id="sliding_indicator_transition_class"></a>

### SLIDING\_INDICATOR\_TRANSITION\_CLASS

```ts
const SLIDING_INDICATOR_TRANSITION_CLASS: "pointer-events-none absolute top-0 left-0 z-0 transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] will-change-transform" = "pointer-events-none absolute top-0 left-0 z-0 transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] will-change-transform";
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:4

Sliding pill: position only — width/height snap so the pill glides A→B without fighting size changes.

## Functions

<a id="bindslidingindicatormeasure"></a>

### bindSlidingIndicatorMeasure()

```ts
function bindSlidingIndicatorMeasure(config): (animate) => void;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:33

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `SlidingIndicatorMeasureConfig` |

#### Returns

(`animate`) => `void`

***

<a id="createslidingindicatorscheduler"></a>

### createSlidingIndicatorScheduler()

```ts
function createSlidingIndicatorScheduler(measure): (animate) => void;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:36

Coalesce DOM measures; defer resize snaps while a slide is in flight.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `measure` | (`useTransition`) => `void` |

#### Returns

(`animate`) => `void`

***

<a id="formatslidingindicatorstyle"></a>

### formatSlidingIndicatorStyle()

```ts
function formatSlidingIndicatorStyle(rect, options): string;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:14

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rect` | [`SlidingIndicatorRect`](/docs/api-reference/ui/build/sliding-indicator/sliding-indicator.md#slidingindicatorrect) |
| `options` | \{ `hasPositioned`: `boolean`; `useTransition`: `boolean`; \} |
| `options.hasPositioned` | `boolean` |
| `options.useTransition` | `boolean` |

#### Returns

`string`

***

<a id="observeslidingindicatorresize"></a>

### observeSlidingIndicatorResize()

```ts
function observeSlidingIndicatorResize(
   root,
   schedule,
   selector?): () => void;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:34

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | `HTMLElement` |
| `schedule` | (`animate`) => `void` |
| `selector?` | `string` |

#### Returns

() => `void`

***

<a id="rectfromoffsetelement"></a>

### rectFromOffsetElement()

```ts
function rectFromOffsetElement(el): SlidingIndicatorRect;
```

Defined in: packages/ui/build/sliding-indicator/sliding-indicator.d.ts:13

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `el` | `HTMLElement` |

#### Returns

[`SlidingIndicatorRect`](/docs/api-reference/ui/build/sliding-indicator/sliding-indicator.md#slidingindicatorrect)
