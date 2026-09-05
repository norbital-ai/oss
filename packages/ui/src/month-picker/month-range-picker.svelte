<script lang="ts">
	/**
	 * Picks a span of months: two years side by side, the first click opens the span, the second
	 * closes it (in either order), and the named presets on the right answer the questions a
	 * report asks most.
	 */
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Popover, PopoverContent, PopoverTrigger } from '#lib/popover';
	import { Stack } from '#lib/layout';
	import { useI18n } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import MonthGrid from './month-grid.svelte';
	import {
		compareMonths,
		currentMonthKey,
		MONTH_RANGE_PRESETS,
		monthRangePreset,
		parseMonth,
		rangeLabel,
		type MonthKey,
		type MonthRange,
		type MonthRangePreset
	} from './months.js';

	let {
		value = null,
		onValueChange,
		min,
		max,
		disabled = false,
		placeholder,
		ariaLabel,
		presets = MONTH_RANGE_PRESETS,
		align = 'start',
		class: className
	}: {
		value?: MonthRange | null;
		onValueChange: (range: MonthRange) => void;
		min?: MonthKey;
		max?: MonthKey;
		disabled?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		presets?: readonly MonthRangePreset[];
		align?: 'start' | 'center' | 'end';
		class?: string;
	} = $props();

	const { t, intlLocale } = useI18n();
	const today = currentMonthKey();
	let open = $state(false);
	let viewYear = $state(
		value?.start != null ? parseMonth(value.start).year : parseMonth(today).year
	);
	/** The first endpoint of a span being drawn; `null` between selections. */
	let pending = $state<MonthKey | null>(null);
	let hovered = $state<MonthKey | null>(null);

	watch(
		() => value?.start,
		(start) => {
			if (start != null) viewYear = parseMonth(start).year;
		}
	);
	watch(
		() => open,
		(next) => {
			if (!next) {
				pending = null;
				hovered = null;
			}
		}
	);

	const presetLabel: Record<MonthRangePreset, string> = $derived({
		thisYear: t('monthPicker.thisYear'),
		lastYear: t('monthPicker.lastYear'),
		lastSixMonths: t('monthPicker.lastSixMonths'),
		lastTwelveMonths: t('monthPicker.lastTwelveMonths')
	});

	const outOfBounds = (key: MonthKey): boolean =>
		(min !== undefined && compareMonths(key, min) < 0) ||
		(max !== undefined && compareMonths(key, max) > 0);

	/** The span shown while drawing: the pending endpoint to the hovered month, else the value. */
	const shown = $derived.by((): MonthRange | null => {
		if (pending !== null) {
			const other = hovered ?? pending;
			return compareMonths(pending, other) <= 0
				? { start: pending, end: other }
				: { start: other, end: pending };
		}
		return value ?? null;
	});

	const stateOf = (key: MonthKey) => {
		if (shown === null) return null;
		if (shown.start === shown.end) return key === shown.start ? 'single' : null;
		if (key === shown.start) return 'start';
		if (key === shown.end) return 'end';
		return compareMonths(key, shown.start) > 0 && compareMonths(key, shown.end) < 0
			? 'within'
			: null;
	};

	const select = (key: MonthKey) => {
		if (pending === null) {
			pending = key;
			return;
		}
		const range =
			compareMonths(pending, key) <= 0
				? { start: pending, end: key }
				: { start: key, end: pending };
		pending = null;
		onValueChange(range);
		open = false;
	};

	const label = $derived(value ? rangeLabel(intlLocale, value) : null);
</script>

<Popover bind:open>
	<PopoverTrigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				{disabled}
				aria-label={ariaLabel ?? t('monthPicker.rangePlaceholder')}
				data-month-range-picker
				data-start={value?.start}
				data-end={value?.end}
				class={cn(
					'w-auto min-w-[14rem] justify-start gap-2 font-normal',
					label === null && 'text-muted-foreground',
					className
				)}
			>
				<Icon icon="lucide:calendar-range" class="size-4 shrink-0 text-muted-foreground" />
				<span class="truncate">{label ?? placeholder ?? t('monthPicker.rangePlaceholder')}</span>
			</Button>
		{/snippet}
	</PopoverTrigger>
	<PopoverContent {align} class="w-auto p-3">
		<div class="flex gap-4">
			<Stack gap="sm">
				<div class="grid grid-cols-[2rem_1fr_1fr_2rem] items-center">
					<Button
						variant="ghost"
						size="icon"
						aria-label={t('monthPicker.previousYear')}
						onclick={() => (viewYear -= 1)}
					>
						<Icon icon="lucide:chevron-left" class="size-4" />
					</Button>
					<span class="text-center text-sm font-medium tabular-nums">{viewYear}</span>
					<span class="text-center text-sm font-medium tabular-nums">{viewYear + 1}</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t('monthPicker.nextYear')}
						onclick={() => (viewYear += 1)}
					>
						<Icon icon="lucide:chevron-right" class="size-4" />
					</Button>
				</div>
				<div class="flex gap-4">
					{#each [viewYear, viewYear + 1] as year (year)}
						<MonthGrid
							{year}
							{today}
							state={stateOf}
							disabled={outOfBounds}
							onSelect={select}
							onHover={(key) => (hovered = key)}
						/>
					{/each}
				</div>
			</Stack>
			{#if presets.length > 0}
				<div class="flex flex-col gap-2 border-l border-border pl-4">
					{#each presets as preset (preset)}
						<Button
							variant="outline"
							size="sm"
							class="justify-start"
							data-month-range-preset={preset}
							onclick={() => {
								pending = null;
								onValueChange(monthRangePreset(preset));
								open = false;
							}}
						>
							{presetLabel[preset]}
						</Button>
					{/each}
				</div>
			{/if}
		</div>
	</PopoverContent>
</Popover>
