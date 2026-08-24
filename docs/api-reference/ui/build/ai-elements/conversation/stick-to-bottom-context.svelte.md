[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/ai-elements/conversation/stick-to-bottom-context.svelte

# ui/build/ai-elements/conversation/stick-to-bottom-context.svelte

## Classes

<a id="sticktobottomcontext"></a>

### StickToBottomContext

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:11

Stick-to-bottom for streaming chat.

User latch:
- Any upward scroll / wheel-up → unlock (cancel pending pins)
- Reach the bottom again (or scrollToBottom) → latch

While latched: content ResizeObserver pins scrollTop at most once per frame.
Pins use a synchronous flag (not a time window) so user scroll-up is never swallowed.

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new StickToBottomContext(): StickToBottomContext;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:14

###### Returns

[`StickToBottomContext`](/docs/api-reference/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.md#sticktobottomcontext)

#### Properties

<a id="isatbottom"></a>

##### isAtBottom

```ts
isAtBottom: boolean;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:13

<a id="scrolltobottom"></a>

##### scrollToBottom

```ts
scrollToBottom: (behavior?) => void;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:17

Explicit latch + jump (scroll button / initial mount).

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `behavior?` | `ScrollBehavior` |

###### Returns

`void`

#### Methods

<a id="setelement"></a>

##### setElement()

```ts
setElement(element): void;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:15

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `element` | `HTMLElement` |

###### Returns

`void`

## Functions

<a id="getsticktobottomcontext"></a>

### getStickToBottomContext()

```ts
function getStickToBottomContext(): StickToBottomContext;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:20

#### Returns

[`StickToBottomContext`](/docs/api-reference/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.md#sticktobottomcontext)

***

<a id="setsticktobottomcontext"></a>

### setStickToBottomContext()

```ts
function setStickToBottomContext(): StickToBottomContext;
```

Defined in: packages/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.d.ts:19

#### Returns

[`StickToBottomContext`](/docs/api-reference/ui/build/ai-elements/conversation/stick-to-bottom-context.svelte.md#sticktobottomcontext)
