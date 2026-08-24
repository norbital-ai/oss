[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/tree

# std/build/tree

## Functions

<a id="treefind"></a>

### treeFind()

```ts
function treeFind<T, K>(
   nodes,
   childrenKey,
   predicate): T | null;
```

Defined in: packages/std/build/tree/index.d.ts:2

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `object` |
| `K` *extends* `string` \| `number` \| `symbol` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodes` | readonly `T`[] \| `null` \| `undefined` |
| `childrenKey` | `K` |
| `predicate` | (`node`) => `boolean` |

#### Returns

`T` \| `null`

***

<a id="treeflatten"></a>

### treeFlatten()

```ts
function treeFlatten<T, K>(nodes, childrenKey): T[];
```

Defined in: packages/std/build/tree/index.d.ts:1

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `object` |
| `K` *extends* `string` \| `number` \| `symbol` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodes` | readonly `T`[] \| `null` \| `undefined` |
| `childrenKey` | `K` |

#### Returns

`T`[]
