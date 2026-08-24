[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/approval-actions

# ui/build/collection-table/approval-actions

## Variables

<a id="approvalactionsfor"></a>

### approvalActionsFor

```ts
const approvalActionsFor: (request) => ApprovalActions;
```

Defined in: packages/ui/build/collection-table/approval-actions.d.ts:9

Actions the server offered for the current principal, bounded by the request's live state.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `request` | \| [`CollectionApprovalRequest`](/docs/api-reference/std/build/collection.md#collectionapprovalrequest) \| `undefined` |

#### Returns

`ApprovalActions`
