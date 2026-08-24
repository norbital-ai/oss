[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/approval-anchor

# ui/build/collection-table/approval-anchor

## Variables

<a id="approvalrequestidforrecord"></a>

### approvalRequestIdForRecord

```ts
const approvalRequestIdForRecord: (collectionName, record) => string | undefined;
```

Defined in: packages/ui/build/collection-table/approval-anchor.d.ts:3

Resolves the canonical approval request from either a held domain row or the request inbox row.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `record` | \| [`CollectionRecord`](/docs/api-reference/std/build/collection.md#collectionrecord) \| `undefined` |

#### Returns

`string` \| `undefined`
