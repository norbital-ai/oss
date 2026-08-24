[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/event-calendar/utils

# ui/build/event-calendar/utils

## Functions

<a id="adddays"></a>

### addDays()

```ts
function addDays(date, days): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |
| `days` | `number` |

#### Returns

`Date`

***

<a id="assignlanes"></a>

### assignLanes()

```ts
function assignLanes(events): object[];
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:13

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `events` | `object`[] |

#### Returns

`object`[]

***

<a id="datetopixels"></a>

### dateToPixels()

```ts
function dateToPixels(
   date,
   baseDate,
   hourHeight,
   startHour): number;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:9

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |
| `baseDate` | `Date` |
| `hourHeight` | `number` |
| `startHour` | `number` |

#### Returns

`number`

***

<a id="endofmonth"></a>

### endOfMonth()

```ts
function endOfMonth(date): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:4

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |

#### Returns

`Date`

***

<a id="eventtimelabel"></a>

### eventTimeLabel()

```ts
function eventTimeLabel(event): string;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:20

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | \{ \[`key`: `string`\]: `unknown`; `allDay?`: `boolean`; `color?`: `string`; `editable?`: `boolean`; `end`: `Date`; `id`: `string` \| `number`; `lockedReason?`: `string`; `start`: `Date`; `title`: `string`; \} |
| `event.allDay?` | `boolean` |
| `event.color?` | `string` |
| `event.editable?` | `boolean` |
| `event.end` | `Date` |
| `event.id` | `string` \| `number` |
| `event.lockedReason?` | `string` |
| `event.start` | `Date` |
| `event.title` | `string` |

#### Returns

`string`

***

<a id="formattimelabel"></a>

### formatTimeLabel()

```ts
function formatTimeLabel(date, use24h?): string;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:19

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |
| `use24h?` | `boolean` |

#### Returns

`string`

***

<a id="generatetimeslots"></a>

### generateTimeSlots()

```ts
function generateTimeSlots(
   startHour,
   endHour,
   stepMinutes): string[];
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:18

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `startHour` | `number` |
| `endHour` | `number` |
| `stepMinutes` | `number` |

#### Returns

`string`[]

***

<a id="getmonthgrid"></a>

### getMonthGrid()

```ts
function getMonthGrid(date): object;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:14

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |

#### Returns

`object`

##### days

```ts
days: Date[];
```

##### weekCount

```ts
weekCount: number;
```

***

<a id="ismultidayevent"></a>

### isMultiDayEvent()

```ts
function isMultiDayEvent(event): boolean;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:7

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | \{ \[`key`: `string`\]: `unknown`; `allDay?`: `boolean`; `color?`: `string`; `editable?`: `boolean`; `end`: `Date`; `id`: `string` \| `number`; `lockedReason?`: `string`; `start`: `Date`; `title`: `string`; \} |
| `event.allDay?` | `boolean` |
| `event.color?` | `string` |
| `event.editable?` | `boolean` |
| `event.end` | `Date` |
| `event.id` | `string` \| `number` |
| `event.lockedReason?` | `string` |
| `event.start` | `Date` |
| `event.title` | `string` |

#### Returns

`boolean`

***

<a id="issameday"></a>

### isSameDay()

```ts
function isSameDay(a, b): boolean;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:5

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `a` | `Date` |
| `b` | `Date` |

#### Returns

`boolean`

***

<a id="isweekend"></a>

### isWeekend()

```ts
function isWeekend(date): boolean;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:6

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |

#### Returns

`boolean`

***

<a id="navigateview"></a>

### navigateView()

```ts
function navigateView(
   view,
   date,
   direction): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:12

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `view` | `"month"` \| `"day"` \| `"week"` |
| `date` | `Date` |
| `direction` | `"prev"` \| `"next"` |

#### Returns

`Date`

***

<a id="pixelstodate"></a>

### pixelsToDate()

```ts
function pixelsToDate(
   pixels,
   baseDate,
   hourHeight,
   startHour,
   snapMinutes): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:10

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `pixels` | `number` |
| `baseDate` | `Date` |
| `hourHeight` | `number` |
| `startHour` | `number` |
| `snapMinutes` | `number` |

#### Returns

`Date`

***

<a id="snaptominutes"></a>

### snapToMinutes()

```ts
function snapToMinutes(date, minutes): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:11

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |
| `minutes` | `number` |

#### Returns

`Date`

***

<a id="startofmonth"></a>

### startOfMonth()

```ts
function startOfMonth(date): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:3

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |

#### Returns

`Date`

***

<a id="startofweek"></a>

### startOfWeek()

```ts
function startOfWeek(date): Date;
```

Defined in: packages/ui/build/event-calendar/utils.d.ts:2

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `date` | `Date` |

#### Returns

`Date`
