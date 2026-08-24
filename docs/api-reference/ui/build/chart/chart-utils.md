[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/chart/chart-utils

# ui/build/chart/chart-utils

## Type Aliases

<a id="chartconfig"></a>

### ChartConfig

```ts
type ChartConfig = { [k in string]: { icon?: Component; label?: string } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> }) };
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:8

***

<a id="chartdisplayconfig"></a>

### ChartDisplayConfig

```ts
type ChartDisplayConfig = typeof ChartDisplayConfigSchema.Type;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:30

***

<a id="chartdisplayconfigentry"></a>

### ChartDisplayConfigEntry

```ts
type ChartDisplayConfigEntry = typeof ChartDisplayConfigEntrySchema.Type;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:25

***

<a id="chartdisplayspec"></a>

### ChartDisplaySpec

```ts
type ChartDisplaySpec = CartesianChartSpec | DonutChartSpec;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:75

***

<a id="chartdisplayvalue"></a>

### ChartDisplayValue

```ts
type ChartDisplayValue = string | number | null;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:20

***

<a id="chartdisplayvalueformat"></a>

### ChartDisplayValueFormat

```ts
type ChartDisplayValueFormat = typeof ChartDisplayValueFormatSchema.Type;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:37

## Variables

<a id="themes"></a>

### THEMES

```ts
const THEMES: object;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:4

#### Type Declaration

<a id="dark"></a>

##### dark

```ts
readonly dark: ".dark";
```

<a id="light"></a>

##### light

```ts
readonly light: "";
```

## Functions

<a id="getpayloadconfigfrompayload"></a>

### getPayloadConfigFromPayload()

```ts
function getPayloadConfigFromPayload(
   config,
   payload,
   key):
  | { label?: string | undefined; icon?: Component<{}, {}, string> | undefined; } & ({ color?: string | undefined; theme?: undefined; } | { color?: undefined; theme: Record<"light" | "dark", string>; })
  | undefined;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:76

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`ChartConfig`](/docs/api-reference/ui/build/chart/chart-utils.md#chartconfig) |
| `payload` | `TooltipSeries` |
| `key` | `string` |

#### Returns

  \| \{ label?: string \| undefined; icon?: Component\<\{\}, \{\}, string\> \| undefined; \} & (\{ color?: string \| undefined; theme?: undefined; \} \| \{ color?: undefined; theme: Record\<"light" \| "dark", string\>; \})
  \| `undefined`

***

<a id="setchartcontext"></a>

### setChartContext()

```ts
function setChartContext(value): ChartContextValue;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:89

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `ChartContextValue` |

#### Returns

`ChartContextValue`

***

<a id="usechart"></a>

### useChart()

```ts
function useChart(): ChartContextValue;
```

Defined in: packages/ui/build/chart/chart-utils.d.ts:90

#### Returns

`ChartContextValue`
