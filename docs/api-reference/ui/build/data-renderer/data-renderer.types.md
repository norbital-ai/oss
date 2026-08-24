[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/data-renderer.types

# ui/build/data-renderer/data-renderer.types

## Interfaces

<a id="datarendererprops"></a>

### DataRendererProps

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:2

#### Properties

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:14

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:7

<a id="field"></a>

##### field

```ts
field: CollectionField;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:3

<a id="id"></a>

##### id?

```ts
optional id?: string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:5

<a id="locale"></a>

##### locale?

```ts
optional locale?: string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:13

<a id="mode"></a>

##### mode?

```ts
optional mode?: "display" | "edit";
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:6

<a id="onrowchange"></a>

##### onRowChange?

```ts
optional onRowChange?: (patch) => void;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:12

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `patch` | `Record`\<`string`, `unknown`\> |

###### Returns

`void`

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (value) => void;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:9

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

###### Returns

`void`

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:8

<a id="row"></a>

##### row?

```ts
optional row?: Record<string, unknown>;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:11

Full matrix/form row when the renderer needs sibling fields.

<a id="value"></a>

##### value

```ts
value: unknown;
```

Defined in: packages/ui/build/data-renderer/data-renderer.types.d.ts:4
