[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/matrix/matrix.renderer.svelte

# ui/build/data-renderer/matrix/matrix.renderer.svelte

## Interfaces

<a id="matrixcellrendererprops"></a>

### MatrixCellRendererProps

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:7

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) | [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) |

#### Properties

<a id="disabled"></a>

##### disabled

```ts
disabled: boolean;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:11

<a id="field"></a>

##### field

```ts
field: CollectionField;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:10

<a id="onrowchange"></a>

##### onRowChange

```ts
onRowChange: (patch) => void;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:13

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `patch` | `Record`\<`string`, `unknown`\> |

###### Returns

`void`

<a id="onvaluechange"></a>

##### onValueChange

```ts
onValueChange: (value) => void;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:12

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

###### Returns

`void`

<a id="row"></a>

##### row

```ts
row: TRow;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:8

<a id="value"></a>

##### value

```ts
value: unknown;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:9

***

<a id="matrixcolumn"></a>

### MatrixColumn

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:15

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) |

#### Properties

<a id="field-1"></a>

##### field

```ts
field: CollectionField;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:18

<a id="key"></a>

##### key

```ts
key: Extract<keyof TRow>;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:16

<a id="label"></a>

##### label

```ts
label: string;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:17

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:19

<a id="readonly"></a>

##### readOnly?

```ts
optional readOnly?: boolean;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:22

Render this value as immutable display content inside an otherwise editable matrix.

<a id="relationoptions"></a>

##### relationOptions?

```ts
optional relationOptions?: CollectionRelationOptions<CollectionRecord>;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:20

<a id="renderer"></a>

##### renderer?

```ts
optional renderer?: Component<MatrixCellRendererProps<TRow>, {
}, string>;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:24

Specialized cell content for references that cannot be represented by one scalar field.

<a id="width"></a>

##### width?

```ts
optional width?: number;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:25

***

<a id="matrixrow"></a>

### MatrixRow

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:3

#### Properties

<a id="id"></a>

##### id?

```ts
readonly optional id?: string;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:4

***

<a id="matrixrowactionprops"></a>

### MatrixRowActionProps

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:27

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) | [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) |

#### Properties

<a id="disabled-1"></a>

##### disabled

```ts
disabled: boolean;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:32

Whole matrix is disabled (e.g. form readonly / saving).

<a id="hovered"></a>

##### hovered

```ts
hovered: boolean;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:30

<a id="index"></a>

##### index

```ts
index: number;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:29

<a id="row-1"></a>

##### row

```ts
row: TRow;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:28

<a id="rowdisabled"></a>

##### rowDisabled

```ts
rowDisabled: boolean;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:34

This row’s datatype cells are non-editable via `isRowDisabled`.

## Type Aliases

<a id="default"></a>

### default

```ts
type default<TRow> = InstanceType<typeof default>;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:86

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) |

***

<a id="matrixrendererprops"></a>

### MatrixRendererProps

```ts
type MatrixRendererProps<TRow> = MatrixRendererBaseProps<TRow> & MatrixRendererAddRowsProps<TRow>;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:64

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* [`MatrixRow`](/docs/api-reference/ui/build/data-renderer/matrix/matrix.renderer.svelte.md#matrixrow) |

## Variables

<a id="default-1"></a>

### default

```ts
const default: $$IsomorphicComponent;
```

Defined in: packages/ui/build/data-renderer/matrix/matrix.renderer.svelte.d.ts:86
