<!-- the scalar/multiple temporal editor intentionally owns one cohesive calendar workflow -->
<script lang="ts" generics="TMulti extends boolean">
	// ==================================================================================
	// IMPORTS
	// ==================================================================================
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import { Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import {
		toTime as extractTime,
		getLocalTimeZone,
		parseAbsolute,
		parseTime,
		Time,
		toCalendarDate,
		toCalendarDateTime,
		toZoned,
		type DateValue
	} from '@internationalized/date';
	import { formatUtcInstantLocal, parseUtcInstant } from '@norbital-ai/std/date';
	import { type DateRange } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Scroll, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { RangeCalendar } from '#lib/range-calendar';
	import type { TimeRange } from '#lib/time-range';
	import TimeView from './time.view.svelte';

	type DateMatcher = (date: DateValue) => boolean;

	// ==================================================================================
	// TYPES & INTERFACES
	// ==================================================================================

	const { t } = useI18n<UiKeys>();

	const stringDateRangeSchema = Schema.Struct({
		start: Schema.optionalKey(Schema.String),
		end: Schema.optionalKey(Schema.String)
	});
	type StringDateRange = typeof stringDateRangeSchema.Type;
	type ValueType<T extends boolean> = T extends true ? StringDateRange[] : StringDateRange;
	type OnValueChangeType<T extends boolean> = T extends true
		? (value: StringDateRange[]) => void
		: (value: StringDateRange) => void;

	interface Props<T extends boolean> {
		value: ValueType<T>;
		style?: string;
		multi: T;
		onValueChange?: OnValueChangeType<T>;
		align?: 'start' | 'center' | 'end';
		emptyPlaceholder?: string | Snippet;
		allowClear?: boolean;
		allowTime?: boolean;
		class?: string;
		disabled?: boolean;
		readonly?: boolean;
		/**
		 * When true, renders without borders. Used in collection table cells for inline display.
		 */
		borderless?: boolean;
		maxTriggerRanges?: number;
		numberOfMonths?: number;
		minDate?: string;
		maxDate?: string;
		timeGranularity?: 'minute' | 'second';
		hourCycle?: 12 | 24;
		isDateDisabled?: DateMatcher;
		isDateUnavailable?: DateMatcher;
	}

	// ==================================================================================
	// COMPONENT PROPS
	// ==================================================================================

	let {
		value = $bindable(),
		multi,
		onValueChange,
		align = 'start',
		emptyPlaceholder = t('dataRenderer.pickDateRanges'),
		allowClear = true,
		allowTime = false,
		class: className,
		disabled = false,
		readonly = false,
		borderless = false,
		maxTriggerRanges = 2,
		numberOfMonths = allowTime ? 2 : 1,
		minDate,
		maxDate,
		timeGranularity = 'minute',
		hourCycle = 24,
		style,
		isDateDisabled,
		isDateUnavailable
	}: Props<TMulti> = $props();

	// ==================================================================================
	// UTILITIES
	// ==================================================================================

	const tz = getLocalTimeZone();

	/** Convert stored UTC ISO instant to ZonedDateTime in the viewer timezone. */
	const parseTimestamp = (timestamp: string) =>
		parseAbsolute(parseUtcInstant(timestamp).toISOString(), tz);

	/** Extract DateValue from timestamptz string */
	const toDateValue = (timestamp?: string): DateValue | undefined => {
		if (!timestamp) return undefined;
		return toCalendarDate(parseTimestamp(timestamp));
	};

	/** Extract an editable time, or the local-day boundary for date-only range selection. */
	const timestampToTime = (timestamp: string | undefined, boundary: 'start' | 'end'): Time => {
		if (!allowTime) {
			return boundary === 'start' ? new Time(0, 0) : new Time(23, 59, 59, 999);
		}
		if (!timestamp) return parseTime('09:00:00');
		return extractTime(parseTimestamp(timestamp));
	};

	/** Combine DateValue and Time into timestamptz string */
	const combineDateTime = (date?: DateValue, time?: Time): string | undefined => {
		if (!date || !time) return undefined;
		const calendarDateTime = toCalendarDateTime(date).set({
			hour: time.hour,
			minute: time.minute,
			second: time.second,
			millisecond: time.millisecond
		});
		return toZoned(calendarDateTime, tz).toAbsoluteString();
	};

	// ==================================================================================
	// STATE & DERIVED VALUES
	// ==================================================================================

	let popoverOpen = $state(false);
	let activeRangeIndex = $state(0);
	const cantMutate = $derived(readonly || disabled);

	/** Normalized array of ranges for consistent handling */
	const ranges = $derived.by((): StringDateRange[] => {
		if (multi) return (value as StringDateRange[]) ?? [];
		const singleRange = value as StringDateRange;
		return singleRange && (singleRange.start || singleRange.end) ? [singleRange] : [];
	});

	const activeRange = $derived(ranges[activeRangeIndex] ?? {});
	const hasSelection = $derived(ranges.some((range) => range.start || range.end));

	/** Convert active range to DateRange for calendar */
	const activeDateRange = $derived.by((): DateRange => ({
		start: toDateValue(activeRange.start),
		end: toDateValue(activeRange.end)
	}));

	/** Extract times from active range */
	const activeTimes = $derived.by((): TimeRange<Time> => ({
		start: timestampToTime(activeRange.start, 'start'),
		end: timestampToTime(activeRange.end, 'end')
	}));

	const activeRangeComplete = $derived(activeDateRange.start && activeDateRange.end);
	const isSameDay = $derived.by(() => {
		if (!activeDateRange.start || !activeDateRange.end) return false;
		return activeDateRange.start.compare(activeDateRange.end) === 0;
	});

	const minCalendarDate = $derived(toDateValue(minDate));
	const maxCalendarDate = $derived(toDateValue(maxDate));

	const dateDisabledMatcher = $derived.by((): DateMatcher => {
		return (date: DateValue) => {
			if (isDateDisabled?.(date)) return true;
			if (minCalendarDate && date.compare(minCalendarDate) < 0) return true;
			if (maxCalendarDate && date.compare(maxCalendarDate) > 0) return true;
			return false;
		};
	});

	// ==================================================================================
	// EVENT HANDLERS
	// ==================================================================================

	function updateRange(updatedRange: StringDateRange) {
		if (cantMutate || !onValueChange) return;

		if (multi) {
			const newRanges = [...ranges];
			newRanges[activeRangeIndex] = updatedRange;
			(onValueChange as (value: StringDateRange[]) => void)(newRanges);
		} else {
			(onValueChange as (value: StringDateRange) => void)(updatedRange);
		}
	}

	/** Ignore calendar echoes that did not change the selected days — a rewrite would loop. */
	function handleDateChange(newDateRange: DateRange | undefined) {
		if (!newDateRange) return;

		const startSame =
			(activeDateRange.start === undefined && newDateRange.start === undefined) ||
			(activeDateRange.start !== undefined &&
				newDateRange.start !== undefined &&
				activeDateRange.start.compare(newDateRange.start) === 0);
		const endSame =
			(activeDateRange.end === undefined && newDateRange.end === undefined) ||
			(activeDateRange.end !== undefined &&
				newDateRange.end !== undefined &&
				activeDateRange.end.compare(newDateRange.end) === 0);
		if (startSame && endSame) return;

		updateRange({
			start: combineDateTime(newDateRange.start, activeTimes.start),
			end: combineDateTime(newDateRange.end, activeTimes.end)
		});
	}

	/**
	 * What a time control changed. The three cases are exclusive, so they are stated as one
	 * union rather than as flags that would have to be kept from disagreeing.
	 */
	type TimeEdit =
		| { readonly kind: 'start'; readonly time: Time | undefined }
		| { readonly kind: 'end'; readonly time: Time | undefined }
		| { readonly kind: 'range'; readonly range: TimeRange<Time> | undefined };

	function handleTimeChange(edit: TimeEdit) {
		let { start: newStartTime, end: newEndTime } = activeTimes;

		if (edit.kind === 'start' && edit.time) newStartTime = edit.time;
		if (edit.kind === 'end' && edit.time) newEndTime = edit.time;
		if (edit.kind === 'range' && edit.range) {
			newStartTime = edit.range.start ?? newStartTime;
			newEndTime = edit.range.end ?? newEndTime;
		}

		updateRange({
			start: combineDateTime(activeDateRange.start, newStartTime),
			end: combineDateTime(activeDateRange.end, newEndTime)
		});
	}

	function addNewRange() {
		if (cantMutate || !multi || !onValueChange) return;
		const newRanges = [...ranges, {}];
		(onValueChange as (value: StringDateRange[]) => void)(newRanges);
		activeRangeIndex = newRanges.length - 1;
	}

	function removeRange(indexToRemove: number) {
		if (cantMutate || !multi || !onValueChange) return;
		const newRanges = ranges.filter((_, index) => index !== indexToRemove);
		(onValueChange as (value: StringDateRange[]) => void)(newRanges);
		if (activeRangeIndex >= newRanges.length) {
			activeRangeIndex = Math.max(0, newRanges.length - 1);
		}
	}

	function setActiveRange(index: number) {
		if (cantMutate) return;
		activeRangeIndex = index;
	}

	function clearAllRanges() {
		if (cantMutate || !onValueChange) return;
		if (multi) (onValueChange as (value: StringDateRange[]) => void)([]);
		else (onValueChange as (value: StringDateRange) => void)({});
		activeRangeIndex = 0;
	}

	// ==================================================================================
	// HELPER FUNCTIONS
	// ==================================================================================

	function formatRange(range: StringDateRange): string {
		if (range.start && range.end) {
			return `${formatUtcInstantLocal(range.start, { dateStyle: 'medium', timeStyle: allowTime ? 'short' : undefined })} - ${formatUtcInstantLocal(range.end, { dateStyle: 'medium', timeStyle: allowTime ? 'short' : undefined })}`;
		}
		if (range.start) {
			return `${formatUtcInstantLocal(range.start, { dateStyle: 'medium', timeStyle: allowTime ? 'short' : undefined })} - ...`;
		}
		if (range.end) {
			return `... - ${formatUtcInstantLocal(range.end, { dateStyle: 'medium', timeStyle: allowTime ? 'short' : undefined })}`;
		}
		return t('dataRenderer.selectDates');
	}

	function getRangeStatus(range: StringDateRange): 'complete' | 'partial' | 'empty' {
		if (range.start && range.end) return 'complete';
		if (range.start || range.end) return 'partial';
		return 'empty';
	}
</script>

{#snippet RangeBadge(range: StringDateRange, index: number, isActive: boolean = false)}
	{@const status = getRangeStatus(range)}
	<Inline
		justify="between"
		gap="sm"
		class="rounded-lg border px-3 py-2 text-sm transition-all
       {isActive && !cantMutate ? 'border-brand bg-brand-100' : 'border-border bg-background'}
       {status === 'complete' ? 'shadow-sm' : 'border-dashed'}
       {multi && !isActive && !cantMutate ? 'cursor-pointer hover:bg-muted' : ''}"
		role="button"
		tabindex={0}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				if (multi && !isActive && !cantMutate) setActiveRange(index);
			}
		}}
		onclick={multi && !isActive && !cantMutate ? () => setActiveRange(index) : undefined}
	>
		<Inline gap="sm" grow>
			<div
				class="h-2 w-2 shrink-0 rounded-full
               {status === 'complete'
					? 'bg-success'
					: status === 'partial'
						? 'bg-yellow-500'
						: 'bg-border'}"
			></div>
			<span class="truncate {status === 'empty' ? 'text-muted-foreground' : 'text-foreground'}">
				{formatRange(range)}
			</span>
		</Inline>
		{#if !cantMutate && multi}
			<Inline gap="xs">
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						removeRange(index);
					}}
					class="p-1 text-muted-foreground transition-colors hover:text-destructive"
					aria-label={t('dataRenderer.removeRange')}
				>
					<Icon icon="lucide:x" class="h-3 w-3" />
				</button>
			</Inline>
		{/if}
	</Inline>
{/snippet}

{#snippet TriggerContent()}
	<Icon icon="lucide:calendar" class="size-4 shrink-0" />
	{#if !hasSelection}
		<span class="truncate text-xs font-normal text-muted-foreground">
			{#if typeof emptyPlaceholder === 'string'}
				{emptyPlaceholder}
			{:else if emptyPlaceholder}
				{@render emptyPlaceholder()}
			{:else}
				{t('dataRenderer.pickDateRanges')}
			{/if}
		</span>
	{:else if multi}
		<Inline gap="sm" grow>
			<span class="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-700">
				{ranges.length}
				{t(ranges.length === 1 ? 'dataRenderer.rangeSingular' : 'dataRenderer.rangePlural')}
			</span>
			<span class="truncate text-xs">
				{#if ranges.length <= maxTriggerRanges}
					{ranges.map(formatRange).join(' • ')}
				{:else}
					{ranges.slice(0, maxTriggerRanges).map(formatRange).join(' • ')}
					• {t('misc.moreItems', { count: ranges.length - maxTriggerRanges })}
				{/if}
			</span>
		</Inline>
	{:else}
		<span class="flex-1 truncate text-left text-xs font-normal">{formatRange(ranges[0])}</span>
	{/if}
{/snippet}

{#snippet RangeListSidebar()}
	{#if multi}
		<Stack gap="md" class="border-l border-border bg-muted p-4">
			<Inline justify="between" gap="sm">
				<h4 class="text-sm font-semibold text-foreground">
					{t('dataRenderer.selectedRangesHeading', { count: ranges.length })}
				</h4>
				{#if hasSelection && !cantMutate}
					<button
						type="button"
						onclick={clearAllRanges}
						class="text-xs font-medium text-destructive hover:text-destructive-foreground"
					>
						{t('dataRenderer.clearAll')}
					</button>
				{/if}
			</Inline>
			<Scroll axis="y" name={t('dataRenderer.selectedRangesScroll')}>
				<Stack gap="sm">
					{#each ranges as range, index (index)}
						{@render RangeBadge(range, index, index === activeRangeIndex)}
					{/each}
					{#if ranges.length === 0}
						<Stack gap="sm" align="center" class="py-8 text-center text-muted-foreground">
							<Icon icon="lucide:calendar" class="size-8" />
							<p class="text-sm">{t('dataRenderer.noRanges')}</p>
						</Stack>
					{/if}
				</Stack>
			</Scroll>
			<button
				type="button"
				onclick={addNewRange}
				disabled={cantMutate}
				class="w-full rounded-lg border-2 border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-brand-300 hover:text-brand disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground"
			>
				<Inline gap="sm" justify="center">
					<Icon icon="lucide:plus" class="h-4 w-4" />
					{t('dataRenderer.addRange')}
				</Inline>
			</button>
		</Stack>
	{/if}
{/snippet}

<Popover.Root bind:open={popoverOpen}>
	<div class={cn('group relative w-full', className)} {style}>
		<Popover.Trigger
			class={cn(
				buttonVariants({ variant: 'outline', class: 'w-full justify-start gap-2' }),
				readonly && 'shadow-none',
				borderless && 'border-none shadow-none'
			)}
			{disabled}
			aria-readonly={readonly}
		>
			{@render TriggerContent()}
		</Popover.Trigger>
		{#if allowClear && hasSelection && !cantMutate}
			<button
				type="button"
				class={cn(
					buttonVariants({ variant: 'outline', size: 'icon' }),
					'pointer-events-auto invisible absolute top-1/2 right-2 h-6 w-6 shrink-0 -translate-y-1/2 text-muted-foreground group-hover:visible hover:text-destructive'
				)}
				onclick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					clearAllRanges();
				}}
				aria-label={t('dataRenderer.clearSelection')}
			>
				<Icon icon="lucide:x" class="h-3 w-3" />
			</button>
		{/if}
	</div>

	<Popover.Content class="w-auto p-0 shadow-lg" {align} sameWidth={false}>
		<Inline align="stretch" gap="none">
			<Stack gap="md" class="p-4">
				{#if popoverOpen}
					<RangeCalendar
						value={activeDateRange}
						onValueChange={handleDateChange}
						{numberOfMonths}
						readonly={cantMutate}
						excludeDisabled={true}
						isDateDisabled={dateDisabledMatcher}
						{isDateUnavailable}
					/>
					{#if allowTime && activeDateRange.start}
						<TimeView
							class="border-t border-border pt-4"
							{isSameDay}
							hasEnd={Boolean(activeDateRange.end)}
							value={activeTimes}
							granularity={timeGranularity}
							{hourCycle}
							disabled={cantMutate}
							onStartChange={(time) => handleTimeChange({ kind: 'start', time })}
							onEndChange={(time) => handleTimeChange({ kind: 'end', time })}
							onRangeChange={(range) => handleTimeChange({ kind: 'range', range })}
						/>
					{/if}
				{/if}
			</Stack>
			{@render RangeListSidebar()}
		</Inline>
	</Popover.Content>
</Popover.Root>
