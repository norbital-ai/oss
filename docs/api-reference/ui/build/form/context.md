[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/context

# ui/build/form/context

## Type Aliases

<a id="fieldcontext"></a>

### FieldContext

```ts
type FieldContext = FieldProps<unknown>;
```

Defined in: packages/ui/build/form/context.d.ts:15

Field context type (untyped value for context passing)

***

<a id="fieldprops"></a>

### FieldProps

```ts
type FieldProps<TValue> = object;
```

Defined in: packages/ui/build/form/context.d.ts:2

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TValue` | `unknown` |

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-delta"></a> `delta` | [`JsonPatchOperation`](/docs/api-reference/std/build/json.md#jsonpatchoperation)[] | RFC 6902 JSON Patch operations affecting this field | packages/ui/build/form/context.d.ts:9 |
| <a id="property-disabled"></a> `disabled` | `boolean` | - | packages/ui/build/form/context.d.ts:10 |
| <a id="property-errors"></a> `errors` | `string`[] | - | packages/ui/build/form/context.d.ts:7 |
| <a id="property-handleblur"></a> `handleBlur` | () => `void` | - | packages/ui/build/form/context.d.ts:6 |
| <a id="property-handlechange"></a> `handleChange` | (`next`) => `void` | - | packages/ui/build/form/context.d.ts:5 |
| <a id="property-name"></a> `name` | `string` | - | packages/ui/build/form/context.d.ts:3 |
| <a id="property-value"></a> `value` | `TValue` | - | packages/ui/build/form/context.d.ts:4 |

## Functions

<a id="getfield"></a>

### getField()

```ts
function getField(): () => FieldContext;
```

Defined in: packages/ui/build/form/context.d.ts:17

#### Returns

() => [`FieldContext`](/docs/api-reference/ui/build/form/context.md#fieldcontext)

***

<a id="setfield"></a>

### setField()

```ts
function setField<TValue>(getter): void;
```

Defined in: packages/ui/build/form/context.d.ts:16

#### Type Parameters

| Type Parameter |
| ------ |
| `TValue` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `getter` | () => [`FieldProps`](/docs/api-reference/ui/build/form/context.md#fieldprops)\<`TValue`\> |

#### Returns

`void`
