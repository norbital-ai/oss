<script lang="ts">
	/**
	 * Picks one month. A trigger that reads like a field, a popover with one year at a time, the
	 * year stepped from the header — the same shape as the day calendar, one resolution up.
	 */
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Popover, PopoverContent, PopoverTrigger } from '#lib/popover';
	import { useI18n } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import MonthGrid from './month-grid.svelte';
	import {
		compareMonths,
		currentMonthKey,
		monthLabel,
		parseMonth,
		type MonthKey
	} from './months.js';

	let {
		value = null,
		onValueChange,
		min,
		max,
		isMonthDisabled,
		disabled = false,
		placeholder,
		ariaLabel,
		align = 'start',
		class: className
	}: {
		value?: MonthKey | null;
		onValueChange: (month: MonthKey) => void;
		min?: MonthKey;
		max?: MonthKey;
		/** Months the grid leaves unpickable — settled periods, unusable calendars — inside `min`/`max`. */
		isMonthDisabled?: (key: MonthKey) => boolean;
		disabled?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		align?: 'start' | 'center' | 'end';
		class?: string;
	} = $props();

	const { t, intlLocale } = useI18n();
	const today = currentMonthKey();
	let open = $state(false);
	let viewYear = $state(value != null ? parseMonth(value).year : parseMonth(today).year);

	watch(
		() => value,
		(next) => {
			if (next != null) viewYear = parseMonth(next).year;
		}
	);

	const outOfBounds = (key: MonthKey): boolean =>
		(min !== undefined && compareMonths(key, min) < 0) ||
		(max !== undefined && compareMonths(key, max) > 0) ||
		(isMonthDisabled?.(key) ?? false);
	const label = $derived(value == null ? null : monthLabel(intlLocale, value));
</script>

<Popover bind:open>
	<PopoverTrigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				{disabled}
				aria-label={ariaLabel ?? t('monthPicker.placeholder')}
				data-month-picker
				data-value={value ?? undefined}
				class={cn(
					'w-auto min-w-[10rem] justify-start gap-2 font-normal',
					label === null && 'text-muted-foreground',
					className
				)}
			>
				<Icon icon="lucide:calendar" class="size-4 shrink-0 text-muted-foreground" />
				<span class="truncate">{label ?? placeholder ?? t('monthPicker.placeholder')}</span>
			</Button>
		{/snippet}
	</PopoverTrigger>
	<PopoverContent {align} class="w-auto p-3">
		<div class="mb-2 flex items-center justify-between">
			<Button
				variant="ghost"
				size="icon"
				aria-label={t('monthPicker.previousYear')}
				onclick={() => (viewYear -= 1)}
			>
				<Icon icon="lucide:chevron-left" class="size-4" />
			</Button>
			<span class="text-sm font-medium tabular-nums" data-month-picker-year={viewYear}>
				{viewYear}
			</span>
			<Button
				variant="ghost"
				size="icon"
				aria-label={t('monthPicker.nextYear')}
				onclick={() => (viewYear += 1)}
			>
				<Icon icon="lucide:chevron-right" class="size-4" />
			</Button>
		</div>
		<MonthGrid
			year={viewYear}
			{today}
			state={(key) => (key === value ? 'single' : null)}
			disabled={outOfBounds}
			onSelect={(key) => {
				onValueChange(key);
				open = false;
			}}
		/>
	</PopoverContent>
</Popover>
