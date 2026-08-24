[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/resource-scheduler/resource-scheduler.utils

# ui/build/resource-scheduler/resource-scheduler.utils

## Interfaces

<a id="resourceschedulerday"></a>

### ResourceSchedulerDay

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:1

#### Properties

<a id="end"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:5

<a id="key"></a>

##### key

```ts
readonly key: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:2

<a id="label"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:3

<a id="start"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:4

## Functions

<a id="buildresourceschedulerdays"></a>

### buildResourceSchedulerDays()

```ts
function buildResourceSchedulerDays(
   anchorDate,
   view,
   locale?): ResourceSchedulerDay[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:7

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `anchorDate` | `string` |
| `view` | `"month"` \| `"week"` |
| `locale?` | `string` |

#### Returns

[`ResourceSchedulerDay`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.utils.md#resourceschedulerday)[]

***

<a id="resourceschedulerintervalposition"></a>

### resourceSchedulerIntervalPosition()

```ts
function resourceSchedulerIntervalPosition(
   start,
   end,
   rangeStart,
   dayWidth): object;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:12

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `start` | `string` |
| `end` | `string` |
| `rangeStart` | `string` |
| `dayWidth` | `number` |

#### Returns

`object`

##### left

```ts
left: number;
```

##### width

```ts
width: number;
```

***

<a id="shiftresourceschedulerinterval"></a>

### shiftResourceSchedulerInterval()

```ts
function shiftResourceSchedulerInterval(
   start,
   end,
   days,
   resize?): object;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.utils.d.ts:8

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `start` | `string` |
| `end` | `string` |
| `days` | `number` |
| `resize?` | `"start"` \| `"end"` \| `null` |

#### Returns

`object`

##### end

```ts
end: string;
```

##### start

```ts
start: string;
```
