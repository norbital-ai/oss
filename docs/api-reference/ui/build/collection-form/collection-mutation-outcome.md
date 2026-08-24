[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-form/collection-mutation-outcome

# ui/build/collection-form/collection-mutation-outcome

## Variables

<a id="ispendingapprovalsignal"></a>

### isPendingApprovalSignal

```ts
const isPendingApprovalSignal: <I>(input) => input is I & { action: "update" | "create" | "delete"; collection: string; id: string; pending: true; requestId: string };
```

Defined in: packages/ui/build/collection-form/collection-mutation-outcome.d.ts:9

Recognizes Bolt's approval acquisition outcome without coupling the UI package to Bolt's client
runtime. Collection clients expose Promise<void>, so this accepted command is delivered through
their rejection channel as a structured signal rather than a conventional mutation failure.

#### Type Parameters

| Type Parameter |
| ------ |
| `I` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `I` |

#### Returns

input is I & \{ action: "update" \| "create" \| "delete"; collection: string; id: string; pending: true; requestId: string \}

## Functions

<a id="submitcollectionmutation"></a>

### submitCollectionMutation()

```ts
function submitCollectionMutation(mutation): Effect<void, unknown>;
```

Defined in: packages/ui/build/collection-form/collection-mutation-outcome.d.ts:17

Runs a collection mutation while treating an acquired approval as a successful submission.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `mutation` | () => `Promise`\<`void`\> |

#### Returns

`Effect`\<`void`, `unknown`\>
