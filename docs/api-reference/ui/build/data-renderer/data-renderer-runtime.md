[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/data-renderer-runtime

# ui/build/data-renderer/data-renderer-runtime

## Interfaces

<a id="datarendererruntime"></a>

### DataRendererRuntime

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:8

#### Properties

<a id="customtyperenderers"></a>

##### customTypeRenderers

```ts
readonly customTypeRenderers: CustomTypeRendererMap;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:14

#### Methods

<a id="autocompletegeolocation"></a>

##### autocompleteGeolocation()

```ts
autocompleteGeolocation(query): Effect<object[], unknown>;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:9

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `query` | `string` |

###### Returns

`Effect`\<`object`[], `unknown`\>

<a id="createfileuploadclient"></a>

##### createFileUploadClient()

```ts
createFileUploadClient(): IFileUploadClient;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:10

###### Returns

[`IFileUploadClient`](/docs/api-reference/ui/build/file-upload/types.md#ifileuploadclient)

<a id="fileurl"></a>

##### fileUrl()

```ts
fileUrl(key): string;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:12

Resolves a persisted storage key through the host that mounted the workspace.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

###### Returns

`string`

<a id="renderstaticmap"></a>

##### renderStaticMap()

```ts
renderStaticMap(input): Effect<{
  dataBase64: string;
  markerPositions?: readonly object[];
  mimeType: "image/png" | "image/jpeg";
}, unknown>;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:13

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | \{ `markers`: readonly `object`[]; \} |
| `input.markers` | readonly `object`[] |

###### Returns

`Effect`\<\{
  `dataBase64`: `string`;
  `markerPositions?`: readonly `object`[];
  `mimeType`: `"image/png"` \| `"image/jpeg"`;
\}, `unknown`\>

## Type Aliases

<a id="customtyperenderermap"></a>

### CustomTypeRendererMap

```ts
type CustomTypeRendererMap = Readonly<Record<string, Component<DataRendererProps>>>;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:7

## Functions

<a id="getdatarendererruntimecontext"></a>

### getDataRendererRuntimeContext()

```ts
function getDataRendererRuntimeContext():
  | DataRendererRuntime
  | undefined;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:16

#### Returns

  \| [`DataRendererRuntime`](/docs/api-reference/ui/build/data-renderer/data-renderer-runtime.md#datarendererruntime)
  \| `undefined`

***

<a id="setdatarendererruntimecontext"></a>

### setDataRendererRuntimeContext()

```ts
function setDataRendererRuntimeContext(runtime): void;
```

Defined in: packages/ui/build/data-renderer/data-renderer-runtime.d.ts:17

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runtime` | [`DataRendererRuntime`](/docs/api-reference/ui/build/data-renderer/data-renderer-runtime.md#datarendererruntime) |

#### Returns

`void`
