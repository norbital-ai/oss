[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/storage-scope

# ui/build/storage-scope

## Functions

<a id="currentstoragescope"></a>

### currentStorageScope()

```ts
function currentStorageScope(): string | null;
```

Defined in: packages/ui/build/storage-scope/index.d.ts:3

#### Returns

`string` \| `null`

***

<a id="scopedstoragekey"></a>

### scopedStorageKey()

```ts
function scopedStorageKey(key): string;
```

Defined in: packages/ui/build/storage-scope/index.d.ts:11

Namespace a key to the active tenant.

Before the shell has published a scope there is no tenant to attribute a key to, so the key is
returned unscoped: an unscoped key can never collide with a scoped one, and the alternative —
inventing a placeholder scope — would produce entries that no later session can find or clear.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`string`

***

<a id="setstoragescope"></a>

### setStorageScope()

```ts
function setStorageScope(read): void;
```

Defined in: packages/ui/build/storage-scope/index.d.ts:2

Provides the active organization from the workspace component that owns its lifetime.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `read` | () => `string` \| `null` |

#### Returns

`void`
