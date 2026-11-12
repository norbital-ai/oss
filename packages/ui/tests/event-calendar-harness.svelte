<script lang="ts">
	import { untrack } from 'svelte';
	import EventCalendar, { type EventCalendarProps } from '../src/event-calendar/event-calendar.svelte';
	let { initial }: { initial: EventCalendarProps & { date: Date } } = $props();
	let date = $state(untrack(() => initial.date));
	let start_hour = $state(untrack(() => initial.start_hour ?? 0));
	let hour_height = $state(untrack(() => initial.hour_height ?? 56));
	export function set_date(next: Date): void { date = next; }
	export function set_scale(start: number, height: number): void { start_hour = start; hour_height = height; }
</script>

<EventCalendar {...initial} {date} {start_hour} {hour_height} />
