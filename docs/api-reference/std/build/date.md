[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/date

# std/build/date

## Type Aliases

<a id="daterangewire"></a>

### DateRangeWire

```ts
type DateRangeWire = Schema.Schema.Type<typeof DateRangeWireSchema>;
```

Defined in: packages/std/build/date/index.d.ts:12

***

<a id="formatinstantoptions"></a>

### FormatInstantOptions

```ts
type FormatInstantOptions = Intl.DateTimeFormatOptions & object;
```

Defined in: packages/std/build/date/index.d.ts:13

#### Type Declaration

##### locale?

```ts
optional locale?: string;
```

## Variables

<a id="daterangewireschema"></a>

### DateRangeWireSchema

```ts
const DateRangeWireSchema: Schema.Struct<{
  end: Schema.optional<Schema.NullishOr<Schema.String>>;
  start: Schema.optional<Schema.NullishOr<Schema.String>>;
}>;
```

Defined in: packages/std/build/date/index.d.ts:8

An inclusive date range over UTC calendar days, as it travels between client and server.

Both bounds may be absent (an open-ended range) and both may be null (shown as `…`), so the
schema keeps the wire shape explicit; `formatDateRangeLocal` is the one renderer of it.

## Functions

<a id="formatdateiso"></a>

### formatDateISO()

```ts
function formatDateISO(value): string;
```

Defined in: packages/std/build/date/index.d.ts:23

UTC calendar day `YYYY-MM-DD` from a stored instant or calendar string.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` \| `Date` |

#### Returns

`string`

***

<a id="formatdaterangelocal"></a>

### formatDateRangeLocal()

```ts
function formatDateRangeLocal(range, options?): string;
```

Defined in: packages/std/build/date/index.d.ts:21

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `range` | \| \{ `end?`: `string` \| `null`; `start?`: `string` \| `null`; \} \| `null` \| `undefined` |
| `options?` | [`FormatInstantOptions`](/docs/api-reference/std/build/date.md#formatinstantoptions) |

#### Returns

`string`

***

<a id="formatutcinstantlocal"></a>

### formatUtcInstantLocal()

```ts
function formatUtcInstantLocal(value, options?): string;
```

Defined in: packages/std/build/date/index.d.ts:20

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |
| `options?` | [`FormatInstantOptions`](/docs/api-reference/std/build/date.md#formatinstantoptions) |

#### Returns

`string`

***

<a id="iscalendardate"></a>

### isCalendarDate()

```ts
function isCalendarDate(value): boolean;
```

Defined in: packages/std/build/date/index.d.ts:17

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`boolean`

***

<a id="isclocktime"></a>

### isClockTime()

```ts
function isClockTime(value): boolean;
```

Defined in: packages/std/build/date/index.d.ts:18

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`boolean`

***

<a id="isutcisoinstant"></a>

### isUtcIsoInstant()

```ts
function isUtcIsoInstant(value): boolean;
```

Defined in: packages/std/build/date/index.d.ts:16

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`boolean`

***

<a id="parseutcinstant"></a>

### parseUtcInstant()

```ts
function parseUtcInstant(value): Date;
```

Defined in: packages/std/build/date/index.d.ts:19

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`Date`
