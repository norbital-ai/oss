[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/geolocation/geolocation.utils

# ui/build/data-renderer/geolocation/geolocation.utils

## Type Aliases

<a id="tgeolocationpickervalue"></a>

### TGeolocationPickerValue

```ts
type TGeolocationPickerValue = typeof geolocationPickerValueSchema.Type;
```

Defined in: packages/ui/build/data-renderer/geolocation/geolocation.utils.d.ts:12

## Functions

<a id="parsegeolocationpickervalues"></a>

### parseGeolocationPickerValues()

```ts
function parseGeolocationPickerValues(value, multiple):
  | {
  formatted_address: string;
  geometry:   | {
     lat: number;
     lon: number;
   }
     | null;
  srid: number;
  type: "Point";
}
  | object[]
  | null;
```

Defined in: packages/ui/build/data-renderer/geolocation/geolocation.utils.d.ts:13

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |
| `multiple` | `boolean` |

#### Returns

  \| \{
  `formatted_address`: `string`;
  `geometry`:   \| \{
     `lat`: `number`;
     `lon`: `number`;
   \}
     \| `null`;
  `srid`: `number`;
  `type`: `"Point"`;
\}
  \| `object`[]
  \| `null`
