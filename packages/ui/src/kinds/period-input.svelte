<!--
@component
Edits a date period (inclusive) or an instant period (closed-open), both ends picked in `precision`.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Value } from './kind.js';
	import type { Precision } from './precision.js';

	/** A date period `{ from, to | null }` (inclusive) or an instant period `{ start, end | null }` (closed-open). */
	export type PeriodInputProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		value: Value;
		on_change(next: Value): void;
		of: 'date' | 'instant';
		/**
		 * The unit both ends are picked in (a field's declared `precision`), snapped: a date period runs from the first day
		 * of its first unit to the last day of its last; an instant period from the start of its first unit to the start of
		 * the unit after its last (closed-open). `year`, `month`, `week` pick from unit grids; `day` and `hour` from the calendar.
		 */
		precision?: Precision;
		/** A range summary trigger; use input for directly editable date/time segments. */
		variant?: 'picker' | 'input';
		/** The id on the trigger, for `<label for>`. */
		id?: string;
		/** Shows the value as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		/** Muted and inert. */
		disabled?: boolean;
		/** Marks the control invalid. */
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import { Result } from 'effect';
	import Icon from '@iconify/svelte';
	import { getLocalTimeZone, parseAbsolute, type DateValue } from '@internationalized/date';
	import { create_calendar, create_date_field } from '../behaviors/index.js';
	import { cn, narrowViewport, ui_text, use_controls } from '../primitives/utils.js';
	import CalendarGrid from './calendar-grid.svelte';
	import { CONTROL, SEGMENT, SEGMENTS } from './classes.js';
	import { dateText, dateValue, fromDay, localDay, snapHour } from './date-input.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { format, value_object } from './kind.js';
	import { datePrecision, unitEnd, unitNext, unitStart, type DatePrecision } from './precision.js';
	import Show from './show.svelte';
	import UnitPicker from './unit-picker.svelte';
	import { fieldPopoverAlignment } from './popover-alignment.svelte.js';

	let {
		ctx,
		value,
		on_change,
		of,
		precision,
		variant,
		id,
		readonly,
		disabled: ownDisabled,
		invalid = false
	}: PeriodInputProps = $props();
	const controls = use_controls();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const t = ui_text();
	let fieldAnchor = $state<HTMLElement | null>(null);
	let calendarContent = $state<HTMLElement | null>(null);
	let calendarOpen = $state(false);
	const calendarAlignment = fieldPopoverAlignment(
		() => fieldAnchor,
		() => calendarContent,
		() => (narrowViewport.current ? 0 : 8)
	);
	const locale = $derived(ctx.ui.kinds.locale);
	const [a, b] = $derived(of === 'date' ? ['from', 'to'] : ['start', 'end']);
	const v = $derived.by(() => {
		const x = value;
		return value_object(x) ? x : {};
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
		const p = days;
		if (p === null) return;
		const lo = from === null ? null : fromDay(of, unitStart(from, p));
		const hi = to === null ? null : of === 'date' ? unitEnd(to, p) : fromDay(of, unitNext(to, p));
		on_change(lo === null && hi === null ? null : { [a]: lo, [b]: hi });
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
		if (days !== null) {
			emit(
				next.start?.toString().slice(0, 10) ?? null,
				next.end?.toString().slice(0, 10) ?? null
			);
			return;
		}
		const from = dateText(of, next.start && snapHour(next.start, precision)),
			to = dateText(of, next.end && snapHour(next.end, precision));
		on_change(from === null && to === null ? null : { [a]: from, [b]: to });
	}

	const startField = create_date_field({
		value: () => range.start,
		granularity: () => (days !== null ? 'day' : precision === 'hour' ? 'hour' : 'minute'),
		locale: () => locale,
		disabled: () => disabled,
		on_change: (start) => change({ start, end: range.end })
	});

	const endField = create_date_field({
		value: () => range.end,
		granularity: () => (days !== null ? 'day' : precision === 'hour' ? 'hour' : 'minute'),
		locale: () => locale,
		disabled: () => disabled,
		on_change: (end) => change({ start: range.start, end })
	});

	const calendar = create_calendar({
		mode: 'range',
		range: () => range,
		placeholder: () => placeholder,
		on_placeholder_change: (next) => (placeholder = next),
		number_of_months: () => (picker && !narrowViewport.current ? 2 : 1),
		locale: () => locale,
		disabled: () => disabled,
		on_range_change: (next) => {
			change(next);
			if (next.start !== undefined && next.end !== undefined) calendarOpen = false;
		}
	});
</script>

{#if readonly ?? controls.readonly}
	<Show {ctx} readonly kind={displayKind} {value} {id} />
{:else if unit !== null}
	<Popover.Root
		bind:open={unitOpen}
		on_open_change={(open) => {
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
				{ctx}
				{unit}
				inline
				picking_end={choosingEnd}
				value={unitFrom === null ? null : unitStart(unitFrom, unit)}
				end={choosingEnd || endDay === null ? null : unitStart(endDay, unit)}
				on_change={(d) => {
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
		</Popover.Content>
	</Popover.Root>
{:else}
	<Popover.Root
		bind:open={calendarOpen}
		on_open_change={(open) => {
			if (open) calendar.reset_pending();
		}}
	>
		{#if picker}
			<Popover.Trigger
				bind:ref={fieldAnchor}
				{id}
				{disabled}
				class={cn(CONTROL, 'flex w-full min-w-0 items-center gap-2 text-left text-sm font-normal')}
				aria-invalid={invalid ? 'true' : undefined}
				data-period-input={of}
				data-precision={precision}
			>
				<Icon icon="lucide:calendar-range" class="size-4 shrink-0 text-muted-foreground" /><span
					class="truncate">{summary}</span
				>
			</Popover.Trigger>
		{:else}
			<div
				bind:this={fieldAnchor}
				class={cn(SEGMENTS, 'pr-1 max-md:h-auto max-md:flex-wrap')}
				aria-invalid={invalid ? 'true' : undefined}
				data-period-input={of}
				data-precision={precision}
			>
				<span {id} class="inline-flex items-center">
					{#each startField.segments as seg, i (i)}
						<span
							{@attach startField.segment_ref(seg.part)}
							{...startField.segment_attrs(seg)}
							class={SEGMENT}>{seg.value}</span
						>
					{/each}
				</span>
				<span class="px-2 text-muted-foreground" aria-hidden="true">–</span>
				<span class="inline-flex items-center">
					{#each endField.segments as seg, i (i)}
						<span
							{@attach endField.segment_ref(seg.part)}
							{...endField.segment_attrs(seg)}
							class={SEGMENT}>{seg.value}</span
						>
					{/each}
				</span>
				<Popover.Trigger
					{disabled}
					class="ml-auto grid size-6 [--hit-target:1.5rem] place-items-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-label={t('openCalendar')}
				>
					<Icon icon="lucide:calendar-range" class="size-4" />
				</Popover.Trigger>
			</div>
		{/if}
		<Popover.Content
			bind:ref={calendarContent}
			custom_anchor={fieldAnchor}
			side_offset={4}
			collision_padding={narrowViewport.current ? 0 : 8}
			align={calendarAlignment.current}
			class="w-auto max-w-[calc(100vw-1rem)] p-3 max-sm:max-w-[100vw] max-sm:p-0"
		>
			<CalendarGrid {calendar} {locale} range />
		</Popover.Content>
	</Popover.Root>
{/if}
{#if !(readonly ?? controls.readonly) && str(v[b]) === null && str(v[a]) !== null}<p
		class="text-meta"
	>
		{t('openEnded')}
	</p>{/if}
