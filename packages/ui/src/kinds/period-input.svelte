<!--
@component
Edits a date period (inclusive) or an instant period (closed-open), both ends picked in `precision`.
-->
<script lang="ts" module>
	import { Decimal } from '@norbital-ai/std/decimal';
	import { Array as Arr } from 'effect';
	import type { Value } from './kind.js';
	import type { Precision } from './precision.js';

	/** A date period `{ from, to | null }` (inclusive) or an instant period `{ start, end | null }` (closed-open). */
	export type PeriodInputProps = {
		value: Value;
		onChange(next: Value): void;
		of: 'date' | 'instant';
		/**
		 * The unit both ends are picked in (a field's declared `precision`), snapped: a date period runs from the first day
		 * of its first unit to the last day of its last; an instant period from the start of its first unit to the start of
		 * the unit after its last (closed-open). `year`, `month`, `week` pick from unit grids; `day` and `hour` from the calendar.
		 */
		precision?: Precision;
		/** A range summary trigger; use input for directly editable date/time segments. */
		variant?: 'picker' | 'input';
		id?: string;
		/** Shows the value as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import { Result } from 'effect';
	import Icon from '@iconify/svelte';
	import { getLocalTimeZone, parseAbsolute, type DateValue } from '@internationalized/date';
	import { DatePicker, DateRangePicker } from 'bits-ui';
	import { cn, narrowViewport, uiText, useControls } from '../primitives/utils.js';
	import CalendarGrid from './calendar-grid.svelte';
	import { SEGMENT, SEGMENTS } from './classes.js';
	import { useKinds } from './context.js';
	import { dateText, dateValue, fromDay, localDay, snapHour } from './date-input.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { CONTROL } from './classes.js';
	import { format } from './kind.js';
	import { datePrecision, unitEnd, unitNext, unitStart, type DatePrecision } from './precision.js';
	import Show from './show.svelte';
	import UnitPicker from './unit-picker.svelte';

	let {
		value,
		onChange,
		of,
		precision,
		variant,
		id,
		readonly,
		disabled: ownDisabled,
		invalid = false
	}: PeriodInputProps = $props();
	const controls = useControls();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const t = uiText();
	const locale = useKinds().locale;
	const [a, b] = $derived(of === 'date' ? ['from', 'to'] : ['start', 'end']);
	const v = $derived.by(() => {
		const x = value;
		return typeof x === 'object' && x !== null && !Arr.isArray<Value>(x) && !(x instanceof Decimal)
			? x
			: {};
	});
	const str = (x: Value | undefined) => (typeof x === 'string' ? x : null);
	const unit = $derived(
		precision === 'year' || precision === 'month' || precision === 'week' ? precision : null
	);
	/** Picked by day (a date period, or an instant period at a day or coarser): the ends are edited as days. */
	const days: DatePrecision | null = $derived(
		of === 'date' ? (unit ?? 'day') : (unit ?? (precision === 'day' ? 'day' : null))
	);
	/** The last day an end covers: a date's `to` itself; an instant's exclusive `end` is the day before it. */
	const lastDay = (s: string | null) => {
		if (s === null) return null;
		if (of === 'date') return s.slice(0, 10);
		return Result.getOrElse(
			Result.try(() =>
				localDay(
					'instant',
					parseAbsolute(s, getLocalTimeZone()).subtract({ milliseconds: 1 }).toAbsoluteString()
				)
			),
			() => null
		);
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
	const range = $derived(
		days !== null
			? { start: dateValue('date', firstDay), end: dateValue('date', endDay) }
			: { start: dateValue(of, str(v[a])), end: dateValue(of, str(v[b])) }
	);
	const displayKind = $derived<import('./kind.js').Kind>(
		of === 'date'
			? { kind: 'period', of: 'date', precision: datePrecision(precision) }
			: { kind: 'period', of: 'instant', precision }
	);
	const picker = $derived(variant === 'picker' || (variant === undefined && days !== null));
	const summary = $derived(
		str(v[a]) === null && str(v[b]) === null ? t('select') : format(displayKind, value, { locale })
	);
	let unitOpen = $state(false);
	let unitFrom = $state<string | null>(null);
	let choosingEnd = $state(false);
	let placeholder = $state<DateValue | undefined>();
	function change(next: { start: DateValue | undefined; end: DateValue | undefined }) {
		if (picker && next.start !== undefined && next.end === undefined) return;
		if (days !== null)
			return emit(
				next.start?.toString().slice(0, 10) ?? null,
				next.end?.toString().slice(0, 10) ?? null
			);
		const from = dateText(of, next.start && snapHour(next.start, precision)),
			to = dateText(of, next.end && snapHour(next.end, precision));
		onChange(from === null && to === null ? null : { [a]: from, [b]: to });
	}
</script>

{#if readonly ?? controls.readonly}
	<Show readonly kind={displayKind} {value} {id} />
{:else if unit !== null}
	<Popover.Root
		bind:open={unitOpen}
		onOpenChange={(open) => {
			if (open) {
				unitFrom = firstDay;
				choosingEnd = false;
			}
		}}
	>
		<Popover.Trigger
			{id}
			{disabled}
			aria-invalid={invalid ? 'true' : undefined}
			class={cn(CONTROL, 'flex w-full min-w-0 items-center gap-2 text-left text-sm font-normal')}
			data-period-input={of}
			data-precision={unit}
			><Icon icon="lucide:calendar-range" class="size-4 shrink-0" /><span class="truncate"
				>{summary}</span
			></Popover.Trigger
		>
		<Popover.Content align="start" class="w-auto max-w-[calc(100vw-1rem)] p-3">
			<UnitPicker
				{unit}
				inline
				pickingEnd={choosingEnd}
				value={unitFrom === null ? null : unitStart(unitFrom, unit)}
				end={choosingEnd || endDay === null ? null : unitStart(endDay, unit)}
				onChange={(d) => {
					if (d === null) return;
					if (!choosingEnd || unitFrom === null) {
						unitFrom = d;
						choosingEnd = true;
					} else {
						emit(d < unitFrom ? d : unitFrom, d < unitFrom ? unitFrom : d);
						unitOpen = false;
					}
				}}
				{disabled}
				{invalid}
			/>
		</Popover.Content></Popover.Root
	>
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
		numberOfMonths={picker && !narrowViewport.current ? 2 : 1}
	>
		{#if picker}
			<DateRangePicker.Trigger
				{id}
				class={cn(CONTROL, 'flex w-full min-w-0 items-center gap-2 text-left text-sm font-normal')}
				aria-invalid={invalid ? 'true' : undefined}
				data-period-input={of}
				data-precision={precision}
			>
				<Icon icon="lucide:calendar-range" class="size-4 shrink-0 text-muted-foreground" /><span
					class="truncate">{summary}</span
				>
			</DateRangePicker.Trigger>
		{:else}
			<div
				class={cn(SEGMENTS, 'pr-1')}
				aria-invalid={invalid ? 'true' : undefined}
				data-period-input={of}
				data-precision={precision}
			>
				{#each ['start', 'end'] as const as type (type)}
					<DateRangePicker.Input {type} id={type === 'start' ? id : undefined}>
						{#snippet children({ segments })}
							{#each segments as { part, value: text }, i (i)}<DateRangePicker.Segment
									{part}
									class={SEGMENT}>{text}</DateRangePicker.Segment
								>{/each}
						{/snippet}
					</DateRangePicker.Input>
					{#if type === 'start'}<span class="px-2 text-muted-foreground" aria-hidden="true">–</span
						>{/if}
				{/each}
				<DateRangePicker.Trigger
					class="ml-auto grid size-7 max-sm:size-11 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-label={t('openCalendar')}
				>
					<Icon icon="lucide:calendar-range" class="size-4" />
				</DateRangePicker.Trigger>
			</div>
		{/if}
		<DatePicker.Portal>
			<DateRangePicker.Content
				sideOffset={4}
				collisionPadding={narrowViewport.current ? 0 : 8}
				align="start"
				class="z-50 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-3 text-popover-foreground shadow-md max-sm:max-w-[100vw] max-sm:p-0"
			>
				<DateRangePicker.Calendar>
					{#snippet children({ months, weekdays })}
						<!-- the range picker's calendar parts are bits' shared calendar parts; only Cell and Day differ, by attributes -->
						<CalendarGrid
							parts={DateRangePicker}
							{months}
							{weekdays}
							{placeholder}
							onPlaceholder={(p) => (placeholder = p)}
							{locale}
							range
						/>
					{/snippet}
				</DateRangePicker.Calendar>
			</DateRangePicker.Content>
		</DatePicker.Portal>
	</DateRangePicker.Root>
{/if}
{#if !(readonly ?? controls.readonly) && str(v[b]) === null && str(v[a]) !== null}<p
		class="text-meta"
	>
		{t('openEnded')}
	</p>{/if}
