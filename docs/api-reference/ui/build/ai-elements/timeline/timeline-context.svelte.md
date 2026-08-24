[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/ai-elements/timeline/timeline-context.svelte

# ui/build/ai-elements/timeline/timeline-context.svelte

## Classes

<a id="timelinecontext"></a>

### TimelineContext

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:3

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new TimelineContext(options?): TimelineContext;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:5

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `isOpen?`: `boolean`; `onOpenChange?`: (`open`) => `void`; \} |
| `options.isOpen?` | `boolean` |
| `options.onOpenChange?` | (`open`) => `void` |

###### Returns

[`TimelineContext`](/docs/api-reference/ui/build/ai-elements/timeline/timeline-context.svelte.md#timelinecontext)

#### Properties

<a id="setisopen"></a>

##### setIsOpen

```ts
setIsOpen: (open) => void;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:11

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `open` | `boolean` |

###### Returns

`void`

#### Accessors

<a id="isopen"></a>

##### isOpen

###### Get Signature

```ts
get isOpen(): boolean;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:9

###### Returns

`boolean`

###### Set Signature

```ts
set isOpen(value): void;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:10

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `boolean` |

###### Returns

`void`

#### Methods

<a id="toggle"></a>

##### toggle()

```ts
toggle(): void;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:12

###### Returns

`void`

## Variables

<a id="gettimelinecontext"></a>

### getTimelineContext

```ts
const getTimelineContext: () => () => TimelineContext;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:1

#### Returns

() => [`TimelineContext`](/docs/api-reference/ui/build/ai-elements/timeline/timeline-context.svelte.md#timelinecontext)

***

<a id="settimelinecontext"></a>

### setTimelineContext

```ts
const setTimelineContext: (context) => () => TimelineContext;
```

Defined in: packages/ui/build/ai-elements/timeline/timeline-context.svelte.d.ts:1

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => [`TimelineContext`](/docs/api-reference/ui/build/ai-elements/timeline/timeline-context.svelte.md#timelinecontext) |

#### Returns

() => [`TimelineContext`](/docs/api-reference/ui/build/ai-elements/timeline/timeline-context.svelte.md#timelinecontext)
