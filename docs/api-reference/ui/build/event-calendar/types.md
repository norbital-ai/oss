[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/event-calendar/types

# ui/build/event-calendar/types

## Interfaces

<a id="editorapi"></a>

### EditorAPI

Defined in: packages/ui/build/event-calendar/types.d.ts:24

#### Properties

<a id="event"></a>

##### event

```ts
event: object;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:25

###### Index Signature

```ts
[key: string]: unknown
```

###### allDay?

```ts
readonly optional allDay?: boolean;
```

###### color?

```ts
readonly optional color?: string;
```

###### editable?

```ts
readonly optional editable?: boolean;
```

###### end

```ts
readonly end: Date;
```

###### id

```ts
readonly id: string | number;
```

###### lockedReason?

```ts
readonly optional lockedReason?: string;
```

###### start

```ts
readonly start: Date;
```

###### title

```ts
readonly title: string;
```

#### Methods

<a id="cancel"></a>

##### cancel()

```ts
cancel(): void;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:27

###### Returns

`void`

<a id="delete"></a>

##### delete()

```ts
delete(): void;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:28

###### Returns

`void`

<a id="save"></a>

##### save()

```ts
save(): void;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:26

###### Returns

`void`

## Type Aliases

<a id="calendarevent"></a>

### CalendarEvent

```ts
type CalendarEvent = typeof CalendarEventSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:14

***

<a id="calendarview"></a>

### CalendarView

```ts
type CalendarView = typeof CalendarViewSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:3

***

<a id="createslot"></a>

### CreateSlot

```ts
type CreateSlot = typeof CreateSlotSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:35

***

<a id="eventchunk"></a>

### EventChunk

```ts
type EventChunk = typeof EventChunkSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:69

***

<a id="eventrendercontext"></a>

### EventRenderContext

```ts
type EventRenderContext = typeof EventRenderContextSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:23

***

<a id="laneassignment"></a>

### LaneAssignment

```ts
type LaneAssignment = typeof LaneAssignmentSchema.Type;
```

Defined in: packages/ui/build/event-calendar/types.d.ts:50
