[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/time\_stamp/timestamp.utils

# ui/build/data-renderer/time\_stamp/timestamp.utils

## Functions

<a id="fromlocaldatetimeparts"></a>

### fromLocalDateTimeParts()

```ts
function fromLocalDateTimeParts(
   date,
   time,
   timeZone?): string | null;
```

Defined in: packages/ui/build/data-renderer/time\_stamp/timestamp.utils.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `string` |
| `time` | `string` |
| `timeZone?` | `string` |

#### Returns

`string` \| `null`

***

<a id="tolocaldatetimeparts"></a>

### toLocalDateTimeParts()

```ts
function toLocalDateTimeParts(value, timeZone?):
  | {
  date: string;
  time: string;
}
  | null;
```

Defined in: packages/ui/build/data-renderer/time\_stamp/timestamp.utils.d.ts:7

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |
| `timeZone?` | `string` |

#### Returns

  \| \{
  `date`: `string`;
  `time`: `string`;
\}
  \| `null`
