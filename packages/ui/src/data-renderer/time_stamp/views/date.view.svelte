<script lang="ts" generics="TMulti extends boolean">
	import Icon from '@iconify/svelte';
	import {
		DateFormatter,
		getLocalTimeZone,
		parseAbsolute,
		type DateValue
	} from '@internationalized/date';
	import { buttonVariants } from '#lib/button';
	import { formatDistance } from 'date-fns/formatDistance';
	import { Calendar } from '#lib/calendar';
	import { Cluster, Inline, Scroll, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { cn, parseUtcInstantZoned } from '#lib/utils';
	import YearView from './year.view.svelte';

	// ==================================================================================
	// TYPES & INTERFACES
	// ==================================================================================

	type ValueType<T extends boolean> = T extends true ? string[] : string | null;
	type OnValueChangeType<T extends boolean> = T extends true
		? (value: string[]) => void
		: (value: string | null) => void;

	interface Props<T extends boolean> {
		value: ValueType<T>;
		multi?: T;
		variant?: 'date' | 'year';
		minYear?: number;
		maxYear?: number;
		align?: 'start' | 'end';
		class?: string;
		disabled?: boolean;
		readonly?: boolean;
		/**
		 * When true, renders without borders. Used in collection table cells for inline display.
		 */
		borderless?: boolean;
		onValueChange?: OnValueChangeType<T>;
		placeholder?: string;
		maxTriggerBadges?: number;
		maxBelowBadges?: number;
		allowClear?: boolean;
		style?: string;
		relativeTime?: boolean; // Now actively used
	}

	// ==================================================================================
	// COMPONENT PROPS
	// ==================================================================================

	let {
		value,
		variant = 'date',
		minYear,
		maxYear,
		relativeTime = false,
		multi,
		allowClear = true,
		disabled = false,
		readonly = false,
		borderless = false,
		onValueChange,
		placeholder = 'Select date',
		maxTriggerBadges = 2,
		maxBelowBadges = 5,
		align = 'start',
		class: className,
		style = ''
	}: Props<TMulti> = $props();

	// ==================================================================================
	// STATE & DERIVED VALUES
	// ==================================================================================

	const df = new DateFormatter('en-US', { dateStyle: 'medium' });
	let popoverOpen = $state(false);
	/** A derived flag to determine if mutation actions should be disabled */
	const cantMutate = $derived(readonly || disabled);

	// Update your dateValues derived to use the helper:
	let dateValues = $derived.by(() => {
		if (multi) {
			const values = value as string[];
			return values.length > 0 ? values.map((v) => parseUtcInstantZoned(v)) : [];
		} else {
			const singleValue = value as string | null;
			return singleValue ? [parseUtcInstantZoned(singleValue)] : [];
		}
	});
	let selectedDateStrings = $derived.by((): string[] => {
		const singleValue = value as string | null;
		return multi ? (value as string[]) : singleValue ? [singleValue] : [];
	});

	let hasSelection = $derived(selectedDateStrings.length > 0);
	const selectedYear = $derived(
		selectedDateStrings[0] && /^\d{4}/.test(selectedDateStrings[0])
			? Number(selectedDateStrings[0].slice(0, 4))
			: null
	);

	// ==================================================================================
	// DATE FORMATTING FUNCTIONS
	// ==================================================================================

	// Also update your formatting functions:
	function formatDateForDisplay(dateStr: string): string {
		if (variant === 'year' && /^\d{4}/.test(dateStr)) return dateStr.slice(0, 4);
		try {
			return df.format(parseUtcInstantZoned(dateStr).toDate());
		} catch {
			return dateStr;
		}
	}

	function formatDateRelative(dateStr: string): string {
		try {
			const date = parseUtcInstantZoned(dateStr).toDate();
			const now = new Date();
			return formatDistance(date, now, { addSuffix: true });
		} catch {
			return dateStr;
		}
	}
	function getDisplayDate(dateStr: string): string {
		return relativeTime ? formatDateRelative(dateStr) : formatDateForDisplay(dateStr);
	}

	// For multi-selection trigger summary when using relative time
	function getRelativeSummary(dateStrings: string[]): string {
		if (dateStrings.length === 0) return '';
		if (dateStrings.length === 1) return getDisplayDate(dateStrings[0]);

		// Sort dates to find earliest and latest
		const dates = dateStrings
			.map((str) => parseAbsolute(str, getLocalTimeZone()).toDate())
			.sort((a, b) => a.getTime() - b.getTime());

		const earliest = dates[0];
		const latest = dates[dates.length - 1];
		const now = new Date();

		if (dateStrings.length === 2) {
			return `${formatDistance(earliest, now, { addSuffix: true })} and ${formatDistance(latest, now, { addSuffix: true })}`;
		}

		return `${dateStrings.length} dates (${formatDistance(earliest, now, { addSuffix: true })} to ${formatDistance(latest, now, { addSuffix: true })})`;
	}

	// ==================================================================================
	// EVENT HANDLERS
	// ==================================================================================

	function handleCalendarChange(newValue: DateValue | DateValue[] | undefined) {
		if (cantMutate || !onValueChange || !newValue) return;

		if (multi) {
			const dateArray = Array.isArray(newValue) ? newValue : [newValue];
			const stringValues = dateArray.map((date) => date.toDate(getLocalTimeZone()).toISOString());
			(onValueChange as (value: string[]) => void)(stringValues);
		} else {
			const dateValue = Array.isArray(newValue) ? newValue[0] : newValue;
			if (dateValue) {
				(onValueChange as (value: string | null) => void)(
					dateValue.toDate(getLocalTimeZone()).toISOString()
				);
				popoverOpen = false;
			}
		}
	}

	function removeDate(dateToRemove: string) {
		if (cantMutate || !multi || !onValueChange) return;
		const currentValues = value as string[];
		const newValues = currentValues.filter((d) => d !== dateToRemove);
		(onValueChange as (value: string[]) => void)(newValues);
	}

	function clearAllDates() {
		if (cantMutate || !onValueChange) return;
		if (multi) (onValueChange as (value: string[]) => void)([]);
		else (onValueChange as (value: string | null) => void)(null);
	}

	function handleYearChange(year: number): void {
		if (cantMutate || !onValueChange || multi) return;
		(onValueChange as (value: string | null) => void)(new Date(Date.UTC(year, 0, 1)).toISOString());
		popoverOpen = false;
	}
</script>

{#snippet DateBadge(dateStr: string, removable: boolean = true, size: 'sm' | 'md' = 'sm')}
	<span
		class="inline-flex items-center rounded-full bg-brand-100 px-2 py-1 text-xs font-normal text-brand-700 transition-all hover:font-medium"
		title={relativeTime ? formatDateForDisplay(dateStr) : formatDateRelative(dateStr)}
	>
		{getDisplayDate(dateStr)}
		{#if removable && !cantMutate}
			<button
				type="button"
				onclick={() => removeDate(dateStr)}
				class="ml-1 text-brand transition-colors hover:text-brand-700"
				aria-label="Remove {getDisplayDate(dateStr)}"
			>
				<Icon icon="radix-icons:cross-1" class="h-2 w-2" />
			</button>
		{/if}
	</span>
{/snippet}

{#snippet TriggerContent()}
	<Icon class="mr-2 h-4 w-4 shrink-0" icon="radix-icons:calendar" />
	{#if !hasSelection}
		<span
			class="truncate text-xs font-normal text-muted-foreground transition-all hover:font-medium"
			>{placeholder}</span
		>
	{:else if multi}
		{#if relativeTime}
			<!-- Show relative summary for multiple dates -->
			<span
				class="flex-1 truncate text-left text-xs font-normal transition-all hover:font-medium"
				title="Click to see all dates"
			>
				{getRelativeSummary(selectedDateStrings)}
			</span>
		{:else}
			<!-- Show badges for multiple dates (original behavior) -->
			<Cluster gap="xs" class="flex-1">
				{#each selectedDateStrings.slice(0, maxTriggerBadges) as dateStr}
					{@render DateBadge(dateStr, false, 'sm')}
				{/each}
				{#if selectedDateStrings.length > maxTriggerBadges}
					<span
						class="inline-flex items-center rounded-full bg-muted px-2 py-1 text-xs font-normal text-muted-foreground transition-all hover:font-medium"
					>
						+{selectedDateStrings.length - maxTriggerBadges} more
					</span>
				{/if}
			</Cluster>
		{/if}
	{:else}
		<!-- Single date selection -->
		<span
			class="flex-1 truncate text-left text-xs font-normal transition-all hover:font-medium"
			title={relativeTime
				? formatDateForDisplay(selectedDateStrings[0])
				: formatDateRelative(selectedDateStrings[0])}
		>
			{getDisplayDate(selectedDateStrings[0])}
		</span>
	{/if}
{/snippet}

{#snippet SelectedDatesSidebar()}
	{#if multi && hasSelection}
		<Stack gap="sm" class="min-w-[220px] border-l border-border bg-muted p-3">
			<Inline justify="between" gap="sm">
				<h4 class="text-xs font-normal text-foreground transition-all hover:font-medium">
					Selected Dates ({selectedDateStrings.length})
				</h4>
				<button
					type="button"
					onclick={clearAllDates}
					disabled={cantMutate}
					class="text-xs font-normal text-destructive transition-all hover:font-medium hover:text-destructive-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:text-muted-foreground"
					aria-label="Clear all selected dates"
				>
					Clear all
				</button>
			</Inline>
			<Scroll axis="y" name="Selected dates" class="max-h-[280px]">
				<Stack gap="sm">
					{#each selectedDateStrings as dateStr}
						<Inline
							justify="between"
							gap="sm"
							class="rounded-lg border border-brand-200 bg-background px-3 py-2 shadow-sm"
						>
							<Stack gap="none" class="min-w-0 flex-1">
								<div
									class="truncate text-xs font-normal text-foreground transition-all hover:font-medium"
								>
									{formatDateForDisplay(dateStr)}
								</div>
								{#if relativeTime}
									<div
										class="text-xs font-normal text-muted-foreground transition-all hover:font-medium"
									>
										{formatDateRelative(dateStr)}
									</div>
								{/if}
							</Stack>
							<button
								type="button"
								onclick={() => removeDate(dateStr)}
								disabled={cantMutate}
								class="shrink-0 text-brand transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:text-muted-foreground"
								aria-label="Remove {formatDateForDisplay(dateStr)}"
							>
								<Icon icon="radix-icons:cross-1" class="h-4 w-4" />
							</button>
						</Inline>
					{/each}
				</Stack>
			</Scroll>
		</Stack>
	{/if}
{/snippet}

<Stack gap="sm">
	<Popover.Root open={popoverOpen} onOpenChange={(open) => (popoverOpen = open)}>
		<div class={cn('group relative w-full', className)} {style}>
			<Popover.Trigger
				class={cn(
					buttonVariants({
						variant: 'outline',
						class: 'w-full justify-start bg-background shadow-xs'
					}),
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
					onclick={(e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						clearAllDates();
					}}
					aria-label="Clear selection"
				>
					<Icon icon="lucide:x" class="h-3 w-3" />
				</button>
			{/if}
		</div>

		<Popover.Content class="w-auto p-0 shadow-lg" {align} sameWidth={false}>
			<Inline align="stretch" gap="none">
				<div class={variant === 'year' ? 'w-64 p-3' : 'p-4'}>
					{#if variant === 'year'}
						<YearView {selectedYear} {minYear} {maxYear} onSelect={handleYearChange} />
					{:else if multi}
						<Calendar
							type="multiple"
							value={dateValues}
							onValueChange={handleCalendarChange}
							readonly={cantMutate}
						/>
					{:else}
						<Calendar
							type="single"
							value={dateValues[0] || undefined}
							onValueChange={handleCalendarChange}
							readonly={cantMutate}
						/>
					{/if}
				</div>
				{@render SelectedDatesSidebar()}
			</Inline>
		</Popover.Content>
	</Popover.Root>

	{#if multi && hasSelection && !popoverOpen && !relativeTime}
		<Cluster gap="xs">
			{#each selectedDateStrings.slice(0, maxBelowBadges) as dateStr}
				{@render DateBadge(dateStr, true, 'md')}
			{/each}
			{#if selectedDateStrings.length > maxBelowBadges}
				<span
					class="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-normal text-muted-foreground transition-all hover:font-medium"
				>
					+{selectedDateStrings.length - maxBelowBadges} more
				</span>
			{/if}
		</Cluster>
	{/if}
</Stack>
