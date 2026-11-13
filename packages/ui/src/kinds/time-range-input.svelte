<!--
@component
Edits date, instant or clock ranges, singly or as an array, at the requested precision.
-->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import { value_object, type Value } from './kind.js';
	import type { PeriodInputProps } from './period-input.svelte';
	/** The datatype, precision and controlled scalar or array ranges of TimeRangeInput. */
	export type TimeRangeInputProps = Omit<PeriodInputProps, 'of' | 'value' | 'on_change'> & {
		/** `date` → `{ from, to }` (inclusive); `instant` → `{ start, end }` (closed-open); `time` → `{ start, end }` clocks. */
		of: 'date' | 'instant' | 'time';
		/** One range, or a list of ranges each edited on its own row. */
		value: Value;
		/** Called with the next range or list, matching the shape of `value`. */
		on_change(next: Value): void;
		/** Accessible name for the range control. */
		'aria-label'?: string;
	};
</script>

<script lang="ts">
	import PeriodInput from './period-input.svelte';
	import TimeOfDayRangeInput from './time-of-day-range-input.svelte';
	import TimeList from './time-list.svelte';
	let { value, on_change, of, ...props }: TimeRangeInputProps = $props();
	const list = $derived(Arr.isArray<Value>(value) ? value : null);
	const clock = (v: Value) => {
		const r = value_object(v) ? v : {};
		return {
			start: typeof r.start === 'string' ? r.start : null,
			end: typeof r.end === 'string' ? r.end : null
		};
	};
</script>

{#snippet single(item: Value, change: (next: Value) => void, id: string | undefined)}
	{#if of === 'time'}<TimeOfDayRangeInput
			{...props}
			{id}
			precision={props.precision === 'hour' ? 'hour' : 'minute'}
			value={clock(item)}
			on_change={change}
		/>{:else}<PeriodInput {...props} {id} {of} value={item} on_change={change} />{/if}
{/snippet}
{#if list !== null}
	<TimeList values={list} {on_change} empty={null} id={props.id} readonly={props.readonly} disabled={props.disabled} range>
		{#snippet item(value, change, id)}{@render single(value, change, id)}{/snippet}
	</TimeList>
{:else}{@render single(value, (next) => on_change(next), props.id)}{/if}
