[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/star-rating/types

# ui/build/star-rating/types

## Interfaces

<a id="starratingrootprops"></a>

### StarRatingRootProps

Defined in: packages/ui/build/star-rating/types.d.ts:9

#### Properties

<a id="allowhalf"></a>

##### allowHalf?

```ts
optional allowHalf?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:15

<a id="children"></a>

##### children?

```ts
optional children?: Snippet<[{
  items: object[];
  max: number;
  value: number;
}]>;
```

Defined in: packages/ui/build/star-rating/types.d.ts:22

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/star-rating/types.d.ts:20

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:12

<a id="hoverpreview"></a>

##### hoverPreview?

```ts
optional hoverPreview?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:16

<a id="max"></a>

##### max?

```ts
optional max?: number;
```

Defined in: packages/ui/build/star-rating/types.d.ts:11

<a id="min"></a>

##### min?

```ts
optional min?: number;
```

Defined in: packages/ui/build/star-rating/types.d.ts:18

<a id="name"></a>

##### name?

```ts
optional name?: string;
```

Defined in: packages/ui/build/star-rating/types.d.ts:19

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (value) => void;
```

Defined in: packages/ui/build/star-rating/types.d.ts:21

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `number` |

###### Returns

`void`

<a id="orientation"></a>

##### orientation?

```ts
optional orientation?: "vertical" | "horizontal";
```

Defined in: packages/ui/build/star-rating/types.d.ts:17

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:13

<a id="required"></a>

##### required?

```ts
optional required?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:14

<a id="value"></a>

##### value?

```ts
optional value?: number;
```

Defined in: packages/ui/build/star-rating/types.d.ts:10

***

<a id="starratingstarprops"></a>

### StarRatingStarProps

Defined in: packages/ui/build/star-rating/types.d.ts:3

#### Properties

<a id="class-1"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/star-rating/types.d.ts:6

<a id="disabled-1"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/star-rating/types.d.ts:7

<a id="index"></a>

##### index

```ts
index: number;
```

Defined in: packages/ui/build/star-rating/types.d.ts:4

<a id="state"></a>

##### state

```ts
state: RatingGroupItemState;
```

Defined in: packages/ui/build/star-rating/types.d.ts:5
