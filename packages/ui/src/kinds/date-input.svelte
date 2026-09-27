<!--
@component
Edits a date, instant, time of day or month as typed segments with a calendar or unit grid, snapped to `precision`.
-->
<script lang="ts" module>
	import type { Precision } from './precision.js';
	/** A calendar date, an instant, a time of day or a month: typed segments, and a calendar or unit grid to pick from. */
	export type DateInputProps = {
		value: string | null;
		onChange(next: string | null): void;
		/** `date` → `YYYY-MM-DD`; `instant` → ISO UTC; `time` → `HH:MM`; `month` → `YYYY-MM`. */
		of?: 'date' | 'instant' | 'time' | 'month';
		/**
		 * The unit picked and emitted, snapped to its start (a field's declared `precision`): `year`, `month` and `week`
		 * (from Monday) pick from a unit grid, `day` from the calendar, `hour` a day and an hour; `minute` (the default of
		 * an instant or a time) as typed. An instant snaps in the viewer's zone (rule 68).
		 */
		precision?: Precision;
		id?: string;
		/** Shows the value as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		min?: string;
		max?: string;
	};
	import { getLocalTimeZone, parseAbsolute, parseDate, parseTime, toCalendarDate, toZoned, type DateValue, type Time } from '@internationalized/date';
	/** A stored value as the picker's date value; an unreadable one is empty, never a throw. */
	export function dateValue(of: 'date' | 'instant', s: string | null | undefined): DateValue | undefined {
		if (s === null || s === undefined || s === '') return undefined;
		try { return of === 'date' ? parseDate(s.slice(0, 10)) : parseAbsolute(s, getLocalTimeZone()); } catch { return undefined; }
	}
	/** The picker's value as stored: a date's `YYYY-MM-DD`, an instant's ISO UTC (edited in the viewer's zone, rule 68; an unzoned pick is read there). */
	export const dateText = (of: 'date' | 'instant', v: DateValue | undefined): string | null =>
		v === undefined ? null : of === 'date' ? v.toString().slice(0, 10) : toZoned(v, getLocalTimeZone()).toAbsoluteString();
	export function timeValue(s: string | null | undefined): Time | undefined {
		if (s === null || s === undefined || s === '') return undefined;
		try { return parseTime(s); } catch { return undefined; }
	}
	/** An instant's calendar day in the viewer's zone, or a date's own (`YYYY-MM-DD`). */
	export function localDay(of: 'date' | 'instant', s: string | null | undefined): string | null {
		const v = dateValue(of, s);
		return v === undefined ? null : toCalendarDate(v).toString();
	}
	/** A day as the field stores it: a date as is, an instant as that day's midnight in the viewer's zone. */
	export const fromDay = (of: 'date' | 'instant', d: string): string => of === 'date' ? d : toZoned(parseDate(d), getLocalTimeZone()).toAbsoluteString();
	/** An instant picked at `hour` precision loses its minutes; any other is as picked. */
	export const snapHour = (v: DateValue, p: Precision | undefined): DateValue =>
		p === 'hour' && 'hour' in v ? v.set({ minute: 0, second: 0, millisecond: 0 }) : v;
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { DatePicker, TimeField } from 'bits-ui';
	import { onDestroy } from 'svelte';
	import { watch } from 'runed';
	import { cn, useControls } from '../primitives/utils.js';
	import CalendarGrid from './calendar-grid.svelte';
	import { SEGMENT, SEGMENTS } from './classes.js';
	import { useKinds } from './context.js';
	import { snapTime, unitStart } from './precision.js';
	import ReadValue from './read-value.svelte';
	import UnitPicker from './unit-picker.svelte';

	let { value, onChange, of = 'date', precision, id, readonly, disabled: ownDisabled, invalid = false, min, max }: DateInputProps = $props();
	const controls = useControls();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const locale = useKinds().locale;
	const kind = $derived(of === 'instant' ? 'instant' : 'date');
	/** A year, month or week of a date or an instant: picked from a unit grid. */
	const unit = $derived((of === 'date' || of === 'instant') && (precision === 'year' || precision === 'month' || precision === 'week') ? precision : null);
	/** A date, or an instant at a day's precision or coarser: the calendar edits a day. */
	const byDay = $derived(of === 'date' || unit !== null || precision === 'day');
	const shown = (s: string | null | undefined) => byDay ? dateValue('date', localDay(kind, s)) : dateValue('instant', s);
	const unitValue = $derived.by(() => { const d = localDay(kind, value); return unit === null || d === null ? null : unitStart(d, unit); });
	let placeholder = $state<DateValue | undefined>();
	// a typed segment commits when it is done, never per key: bits-ui answers every digit ("0" of "03" is the 1st), and each
	// commit is a caller's write, query or URL change. Held while a segment has focus; its leaving or a pause commits it.
	// bits-ui also repeats a value across a segment's advance: a value is sent once.
	let held: string | null | undefined, pause: ReturnType<typeof setTimeout> | undefined;
	// svelte-ignore state_referenced_locally
	let sent = value;
	function commit(next: string | null): void {
		clearTimeout(pause);
		held = next;
		if (document.activeElement instanceof HTMLElement && document.activeElement.dataset['segment'] !== undefined) pause = setTimeout(flush, 800);
		else flush();
	}
	function flush(): void {
		clearTimeout(pause);
		const next = held;
		held = undefined;
		if (next === undefined || next === sent) return;
		sent = next;
		onChange(next);
	}
	watch(() => value, (v) => { sent = v; });
	onDestroy(flush);
	// bits-ui's `hour` granularity drops the minute but keeps the second: segments render `hour::second` and never fill.
	// `hour` precision edits at `minute` with the minute segment unrendered (bits-ui fills only rendered segments); snapHour zeroes it.
</script>

{#if readonly ?? controls.readonly}
	<ReadValue kind={of === 'month' ? { kind: 'date', precision: 'month' } : { kind: of, precision }} {value} {id} />
{:else if of === 'month'}
	<UnitPicker unit="month" value={value === null ? null : `${value.slice(0, 7)}-01`} onChange={(d) => onChange(d === null ? null : d.slice(0, 7))} {id} {disabled} {invalid}
		min={min === undefined ? undefined : `${min.slice(0, 7)}-01`} max={max === undefined ? undefined : `${max.slice(0, 7)}-01`} />
{:else if of === 'time'}
	<TimeField.Root value={timeValue(value)} onValueChange={(t) => commit(t === undefined ? null : snapTime(t.toString(), precision === 'hour' ? 'hour' : undefined))} {disabled} {locale} hourCycle={24} granularity={precision === 'hour' ? 'hour' : 'minute'}>
		<TimeField.Input {id} onfocusout={flush} class={cn(SEGMENTS, 'w-auto')} aria-invalid={invalid ? 'true' : undefined} data-date-input="time" data-precision={precision}>
			{#snippet children({ segments })}
				{#each segments as { part, value: text }, i (i)}<TimeField.Segment {part} class={SEGMENT}>{text}</TimeField.Segment>{/each}
			{/snippet}
		</TimeField.Input>
	</TimeField.Root>
{:else if unit !== null}
	<UnitPicker {unit} value={unitValue} onChange={(d) => onChange(d === null ? null : fromDay(kind, d))} {id} {disabled} {invalid}
		min={localDay(kind, min) ?? undefined} max={localDay(kind, max) ?? undefined} />
{:else}
	<DatePicker.Root
		value={shown(value)}
		onValueChange={(v) => commit(v === undefined ? null : byDay ? fromDay(kind, v.toString().slice(0, 10)) : dateText('instant', snapHour(v, precision)))}
		bind:placeholder
		granularity={byDay ? 'day' : 'minute'}
		hideTimeZone
		hourCycle={24}
		{locale}
		{disabled}
		minValue={shown(min)}
		maxValue={shown(max)}
		weekdayFormat="short"
	>
		<DatePicker.Input {id} onfocusout={flush} class={cn(SEGMENTS, 'pr-1')} aria-invalid={invalid ? 'true' : undefined} data-date-input={of} data-precision={precision}>
			{#snippet children({ segments })}
				{#each segments as { part, value: text }, i (i)}{#if !(precision === 'hour' && (part === 'minute' || (part === 'literal' && segments[i + 1]?.part === 'minute')))}<DatePicker.Segment {part} class={SEGMENT}>{text}</DatePicker.Segment>{/if}{/each}
				<DatePicker.Trigger class="ml-auto grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Open calendar">
					<Icon icon="lucide:calendar" class="size-4" />
				</DatePicker.Trigger>
			{/snippet}
		</DatePicker.Input>
		<DatePicker.Portal>
			<DatePicker.Content sideOffset={4} class="z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
				<DatePicker.Calendar>
					{#snippet children({ months, weekdays })}
						<CalendarGrid parts={DatePicker} {months} {weekdays} {placeholder} onPlaceholder={(p) => (placeholder = p)} {locale} />
					{/snippet}
				</DatePicker.Calendar>
			</DatePicker.Content>
		</DatePicker.Portal>
	</DatePicker.Root>
{/if}
