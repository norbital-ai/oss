# Event calendar

`EventCalendar` and its `CalendarEvent` and `CalendarView`
types are exported from `@norbital-ai/ui`.

An event has `id`, `title`, `start` and `end`. Set `all_day: true` to present an event in the
all-day band, including one whose start and end share a date. Set `editable: false` to prevent
dragging and resizing; `locked_reason` supplies the timed event's tooltip. `color` supplies
its accent colour.

```svelte
<script lang="ts">
	import { EventCalendar, type CalendarEvent } from '@norbital-ai/ui';
	let { events }: { events: readonly CalendarEvent[] } = $props();
</script>

<EventCalendar {events} view="week" />
```

Use `on_event_click` to open an event. The calendar reports an empty-slot selection through
`on_event_create({ start, end })` and a move or resize through
`on_event_move(event, start, end)`. The caller writes the change and supplies updated events.
`readonly` prevents creation, moving and resizing while preserving event opening.

`start_hour`, `end_hour`, `hour_height`, `snap_minutes` and `col_width` configure the time
grid. `on_view_change` and `on_date_change` report navigation. `event_content` renders an
event with its current `view` and `mode` (`box`, `bar` or `pill`); `actions` adds calendar
controls. Narrow containers present month days above an agenda and week days above a single
day's grid. Touch input scrolls and taps; pointer input also creates, moves and resizes.
