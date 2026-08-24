[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/ai-elements/confirmation/confirmation-context.svelte

# ui/build/ai-elements/confirmation/confirmation-context.svelte

## Type Aliases

<a id="confirmationcontextvalue"></a>

### ConfirmationContextValue

```ts
type ConfirmationContextValue = object;
```

Defined in: packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:19

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-approval"></a> `approval` | [`ToolUIPartApproval`](/docs/api-reference/ui/build/ai-elements/confirmation/confirmation-context.svelte.md#tooluipartapproval) | packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:20 |
| <a id="property-state"></a> `state` | [`ToolUIPartState`](/docs/api-reference/ui/build/ai-elements/confirmation/confirmation-context.svelte.md#tooluipartstate) | packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:21 |

***

<a id="tooluipartapproval"></a>

### ToolUIPartApproval

```ts
type ToolUIPartApproval =
  | {
  approved?: never;
  id: string;
  reason?: never;
}
  | {
  approved: boolean;
  id: string;
  reason?: string;
}
  | {
  approved: true;
  id: string;
  reason?: string;
}
  | {
  approved: false;
  id: string;
  reason?: string;
}
  | undefined;
```

Defined in: packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:1

***

<a id="tooluipartstate"></a>

### ToolUIPartState

```ts
type ToolUIPartState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-denied"
  | "output-available";
```

Defined in: packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:18

## Functions

<a id="getconfirmationcontext"></a>

### getConfirmationContext()

```ts
function getConfirmationContext(): ConfirmationContextValue;
```

Defined in: packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:24

#### Returns

[`ConfirmationContextValue`](/docs/api-reference/ui/build/ai-elements/confirmation/confirmation-context.svelte.md#confirmationcontextvalue)

***

<a id="setconfirmationcontext"></a>

### setConfirmationContext()

```ts
function setConfirmationContext(value): void;
```

Defined in: packages/ui/build/ai-elements/confirmation/confirmation-context.svelte.d.ts:23

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | [`ConfirmationContextValue`](/docs/api-reference/ui/build/ai-elements/confirmation/confirmation-context.svelte.md#confirmationcontextvalue) |

#### Returns

`void`
