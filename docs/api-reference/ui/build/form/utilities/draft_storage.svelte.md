[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/utilities/draft\_storage.svelte

# ui/build/form/utilities/draft\_storage.svelte

## Classes

<a id="draftstorage"></a>

### DraftStorage

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:20

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | `Record`\<`string`, `unknown`\> |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new DraftStorage<T>(config): DraftStorage<T>;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:27

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `DraftStorageConfig` |

###### Returns

[`DraftStorage`](/docs/api-reference/ui/build/form/utilities/draft_storage.svelte.md#draftstorage)\<`T`\>

#### Properties

<a id="exists"></a>

##### exists

```ts
exists: boolean;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:23

<a id="hadschemamismatch"></a>

##### hadSchemaMismatch

```ts
hadSchemaMismatch: boolean;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:24

<a id="key"></a>

##### key

```ts
readonly key: string;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:21

<a id="schemahash"></a>

##### schemaHash

```ts
schemaHash: string | null;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:22

#### Methods

<a id="clear"></a>

##### clear()

```ts
clear(): void;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:36

###### Returns

`void`

<a id="destroy"></a>

##### destroy()

```ts
destroy(): void;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:37

###### Returns

`void`

<a id="getmetadata"></a>

##### getMetadata()

```ts
getMetadata():
  | {
  lastModified: number;
  schemaMatch: boolean;
}
  | null;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:32

###### Returns

  \| \{
  `lastModified`: `number`;
  `schemaMatch`: `boolean`;
\}
  \| `null`

<a id="load"></a>

##### load()

```ts
load(): T | null;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:31

###### Returns

`T` \| `null`

<a id="save"></a>

##### save()

```ts
save(data): void;
```

Defined in: packages/ui/build/form/utilities/draft\_storage.svelte.d.ts:30

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `T` |

###### Returns

`void`
