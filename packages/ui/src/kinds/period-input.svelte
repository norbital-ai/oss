<!--
@component
Edits a date period (inclusive) or an instant period (closed-open), both ends picked in `precision`.
-->
<script lang="ts" module>
	import type { Json } from './kind.js';
	import type { Precision } from './precision.js';

	/** A date period `{ from, to | null }` (inclusive) or an instant period `{ start, end | null }` (closed-open). */
	export type PeriodInputProps = {
		value: Json;
		onChange(next: Json): void;
		of: 'date' | 'instant';
		/**
		 * The unit both ends are picked in (a field's declared `precision`), snapped: a date period runs from the first day
		 * of its first unit to the last day of its last; an instant period from the start of its first unit to the start of
		 * the unit after its last (closed-open). `year`, `month`, `week` pick from unit grids; `day` and `hour` from the calendar.
		 */
		precision?: Precision;
		id?: string;
		/** Shows the value as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { getLocalTimeZone, parseAbsolute, type DateValue } from '@internationalized/date';
	import { DatePicker, DateRangePicker } from 'bits-ui';
	import { cn, uiText, useControls } from '../primitives/utils.js';
	import CalendarGrid from './calendar-grid.svelte';
	import { SEGMENT, SEGMENTS } from './classes.js';
	import { useKinds } from './context.js';
	import { dateText, dateValue, fromDay, localDay, snapHour } from './date-input.svelte';
	import { untag } from './kind.js';
	import { unitEnd, unitNext, unitStart, type DatePrecision } from './precision.js';
	import ReadValue from './read-value.svelte';
	import UnitPicker from './unit-picker.svelte';

	let { value, onChange, of, precision, id, readonly, disabled: ownDisabled, invalid = false }: PeriodInputProps = $props();
	const controls = useControls();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const t = uiText();
	const locale = useKinds().locale;
	const [a, b] = $derived(of === 'date' ? ['from', 'to'] : ['start', 'end']);
	const v = $derived.by(() => {
		const x = untag(value);
		return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as { readonly [k: string]: Json }) : {};
	});
	const str = (x: Json | undefined) => (typeof x === 'string' ? x : null);
	const unit = $derived(precision === 'year' || precision === 'month' || precision === 'week' ? precision : null);
	/** Picked by day (a date period, or an instant period at a day or coarser): the ends are edited as days. */
	const days: DatePrecision | null = $derived(of === 'date' ? (unit ?? 'day') : unit ?? (precision === 'day' ? 'day' : null));
	/** The last day an end covers: a date's `to` itself; an instant's exclusive `end` is the day before it. */
	const lastDay = (s: string | null) => {
		if (s === null) return null;
		if (of === 'date') return s.slice(0, 10);
		try { return localDay('instant', parseAbsolute(s, getLocalTimeZone()).subtract({ milliseconds: 1 }).toAbsoluteString()); } catch { return null; }
	};
	const firstDay = $derived(days === null ? null : localDay(of, str(v[a])));
	const endDay = $derived(days === null ? null : lastDay(str(v[b])));
	/** A period from the first unit's start to the last unit's end, as the kind stores its ends. */
	function emit(from: string | null, to: string | null) {
		const p = days!;
		const lo = from === null ? null : fromDay(of, unitStart(from, p));
		const hi = to === null ? null : of === 'date' ? unitEnd(to, p) : fromDay(of, unitNext(to, p));
		onChange(lo === null && hi === null ? null : { [a]: lo, [b]: hi });
	}
	const range = $derived(days !== null
		? { start: dateValue('date', firstDay), end: dateValue('date', endDay) }
		: { start: dateValue(of, str(v[a])), end: dateValue(of, str(v[b])) });
	let placeholder = $state<DateValue | undefined>();
	function change(next: { start: DateValue | undefined; end: DateValue | undefined }) {
		if (days !== null) return emit(next.start?.toString().slice(0, 10) ?? null, next.end?.toString().slice(0, 10) ?? null);
		const from = dateText(of, next.start && snapHour(next.start, precision)), to = dateText(of, next.end && snapHour(next.end, precision));
		onChange(from === null && to === null ? null : { [a]: from, [b]: to });
	}
</script>

{#if readonly ?? controls.readonly}
	<ReadValue kind={{ kind: 'period', of, precision }} {value} {id} />
{:else if unit !== null}
	<!-- two unit grids: the first unit and the last one the period covers -->
	<div class="flex items-center gap-2" data-period-input={of} data-precision={unit}>
		<UnitPicker {unit} value={firstDay === null ? null : unitStart(firstDay, unit)} onChange={(d) => emit(d, endDay)} {id} {disabled} {invalid} max={endDay ?? undefined} />
		<span class="text-muted-foreground" aria-hidden="true">–</span>
		<UnitPicker {unit} value={endDay === null ? null : unitStart(endDay, unit)} onChange={(d) => emit(firstDay, d)} {disabled} {invalid} min={firstDay ?? undefined} />
	</div>
{:else}
<DateRangePicker.Root
	value={range}
	onValueChange={change}
	bind:placeholder
	granularity={days !== null ? 'day' : precision === 'hour' ? 'hour' : 'minute'}
	hideTimeZone
	hourCycle={24}
	{locale}
	{disabled}
	weekdayFormat="short"
>
	<div class={cn(SEGMENTS, 'pr-1')} aria-invalid={invalid ? 'true' : undefined} data-period-input={of} data-precision={precision}>
		{#each ['start', 'end'] as const as type (type)}
			<DateRangePicker.Input {type} id={type === 'start' ? id : undefined}>
				{#snippet children({ segments })}
					{#each segments as { part, value: text }, i (i)}<DateRangePicker.Segment {part} class={SEGMENT}>{text}</DateRangePicker.Segment>{/each}
				{/snippet}
			</DateRangePicker.Input>
			{#if type === 'start'}<span class="px-2 text-muted-foreground" aria-hidden="true">–</span>{/if}
		{/each}
		<DateRangePicker.Trigger class="ml-auto grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Open calendar">
			<Icon icon="lucide:calendar-range" class="size-4" />
		</DateRangePicker.Trigger>
	</div>
	<DatePicker.Portal>
		<DateRangePicker.Content sideOffset={4} class="z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
			<DateRangePicker.Calendar>
				{#snippet children({ months, weekdays })}
					<!-- the range picker's calendar parts are bits' shared calendar parts; only Cell and Day differ, by attributes -->
					<CalendarGrid parts={DateRangePicker as unknown as typeof DatePicker} {months} {weekdays} {placeholder} onPlaceholder={(p) => (placeholder = p)} {locale} range />
				{/snippet}
			</DateRangePicker.Calendar>
		</DateRangePicker.Content>
	</DatePicker.Portal>
</DateRangePicker.Root>
{/if}
{#if !(readonly ?? controls.readonly) && str(v[b]) === null && str(v[a]) !== null}<p class="text-meta">{t('openEnded')}</p>{/if}
