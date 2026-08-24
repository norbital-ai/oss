[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/tags-input/types

# ui/build/tags-input/types

## Interfaces

<a id="coloredtagsinputprops"></a>

### ColoredTagsInputProps

Defined in: packages/ui/build/tags-input/types.d.ts:58

Props for the ColoredTagsInput component

#### Extends

- `Omit`\<`HTMLInputAttributes`, `"value"` \| `"type"`\>

#### Indexable

```ts
[key: symbol]: false | Attachment<HTMLInputElement> | null | undefined
```

```ts
[key: `data-${string}`]: any
```

#### Properties

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/tags-input/types.d.ts:62

CSS class name

###### Overrides

```ts
Omit.class
```

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/tags-input/types.d.ts:68

Whether the input is disabled

###### Overrides

```ts
Omit.disabled
```

<a id="displayvalue"></a>

##### displayValue?

```ts
optional displayValue?: (value) => string;
```

Defined in: packages/ui/build/tags-input/types.d.ts:80

Custom display formatter for colored tags

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | \{ `color`: \| `"red"` \| `"orange"` \| `"yellow"` \| `"green"` \| `"blue"` \| `"purple"` \| `"pink"` \| `"brown"` \| `"grey"` \| `"black"`; `value`: `string`; \} |
| `value.color` | \| `"red"` \| `"orange"` \| `"yellow"` \| `"green"` \| `"blue"` \| `"purple"` \| `"pink"` \| `"brown"` \| `"grey"` \| `"black"` |
| `value.value` | `string` |

###### Returns

`string`

<a id="enablecolorselection"></a>

##### enableColorSelection?

```ts
optional enableColorSelection?: boolean;
```

Defined in: packages/ui/build/tags-input/types.d.ts:86

Enable color selection interface after validation

<a id="fixedtag"></a>

##### fixedTag?

```ts
optional fixedTag?: object;
```

Defined in: packages/ui/build/tags-input/types.d.ts:82

A tag that cannot be deleted

###### color

```ts
readonly color:
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "brown"
  | "grey"
  | "black";
```

###### value

```ts
readonly value: string;
```

<a id="maxtags"></a>

##### maxTags?

```ts
optional maxTags?: number;
```

Defined in: packages/ui/build/tags-input/types.d.ts:64

Maximum number of tags allowed

<a id="maxvisible"></a>

##### maxVisible?

```ts
optional maxVisible?: number;
```

Defined in: packages/ui/build/tags-input/types.d.ts:84

Maximum number of visible tags (shows "+N more" for overflow)

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (values) => void;
```

Defined in: packages/ui/build/tags-input/types.d.ts:74

Callback when values change

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `object`[] |

###### Returns

`void`

<a id="parsevalue"></a>

##### parseValue?

```ts
optional parseValue?: (input) => string | undefined;
```

Defined in: packages/ui/build/tags-input/types.d.ts:78

Custom parser for converting string input to colored tag value

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `string` |

###### Returns

`string` \| `undefined`

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/tags-input/types.d.ts:66

Placeholder text when no tags exist

###### Overrides

```ts
Omit.placeholder
```

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/tags-input/types.d.ts:70

Whether the input is readonly

###### Overrides

```ts
Omit.readonly
```

<a id="type"></a>

##### type?

```ts
optional type?: string;
```

Defined in: packages/ui/build/tags-input/types.d.ts:72

HTML input type (defaults to text for colored tags)

<a id="validate"></a>

##### validate?

```ts
optional validate?: (value, existing) =>
  | {
  color:   | "red"
     | "orange"
     | "yellow"
     | "green"
     | "blue"
     | "purple"
     | "pink"
     | "brown"
     | "grey"
     | "black";
  value: string;
}
  | undefined;
```

Defined in: packages/ui/build/tags-input/types.d.ts:76

Custom validation function - return undefined for invalid values

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | \{ `color`: \| `"red"` \| `"orange"` \| `"yellow"` \| `"green"` \| `"blue"` \| `"purple"` \| `"pink"` \| `"brown"` \| `"grey"` \| `"black"`; `value`: `string`; \} |
| `value.color` | \| `"red"` \| `"orange"` \| `"yellow"` \| `"green"` \| `"blue"` \| `"purple"` \| `"pink"` \| `"brown"` \| `"grey"` \| `"black"` |
| `value.value` | `string` |
| `existing` | `object`[] |

###### Returns

  \| \{
  `color`:   \| `"red"`
     \| `"orange"`
     \| `"yellow"`
     \| `"green"`
     \| `"blue"`
     \| `"purple"`
     \| `"pink"`
     \| `"brown"`
     \| `"grey"`
     \| `"black"`;
  `value`: `string`;
\}
  \| `undefined`

<a id="value"></a>

##### value?

```ts
optional value?: object[];
```

Defined in: packages/ui/build/tags-input/types.d.ts:60

Array of colored tag values

###### color

```ts
readonly color:
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "brown"
  | "grey"
  | "black";
```

###### value

```ts
readonly value: string;
```

## Type Aliases

<a id="coloredtag"></a>

### ColoredTag

```ts
type ColoredTag = typeof ColoredTagSchema.Type;
```

Defined in: packages/ui/build/tags-input/types.d.ts:42

***

<a id="tagcolor"></a>

### TagColor

```ts
type TagColor = typeof TagColorSchema.Type;
```

Defined in: packages/ui/build/tags-input/types.d.ts:34

## Variables

<a id="input_type_configs"></a>

### INPUT\_TYPE\_CONFIGS

```ts
const INPUT_TYPE_CONFIGS: Record<string, InputTypeConfig>;
```

Defined in: packages/ui/build/tags-input/types.d.ts:91

Built-in configurations for common HTML input types
