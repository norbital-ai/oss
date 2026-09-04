<script lang="ts">
	/**
	 * One year of months as a 4×3 grid. Owned by the single and range pickers; the caller decides
	 * what a month means (selected, an endpoint, inside a span) and what is out of bounds.
	 */
	import { cn } from '#lib/utils';
	import { useI18n } from '#lib/i18n';
	import { monthKeyOf, monthNames, type MonthKey } from './months.js';

	export type MonthState = 'single' | 'start' | 'end' | 'within' | null;

	let {
		year,
		state,
		disabled = () => false,
		today,
		onSelect,
		onHover
	}: {
		year: number;
		state: (key: MonthKey) => MonthState;
		disabled?: (key: MonthKey) => boolean;
		today?: MonthKey;
		onSelect: (key: MonthKey) => void;
		onHover?: (key: MonthKey | null) => void;
	} = $props();

	const { intlLocale } = useI18n();
	const names = $derived(monthNames(intlLocale));
</script>

<div class="grid grid-cols-4 gap-y-1" role="grid" data-month-grid={year}>
	{#each names as name, index (index)}
		{@const key = monthKeyOf(year, index + 1)}
		{@const current = state(key)}
		{@const off = disabled(key)}
		<button
			type="button"
			role="gridcell"
			aria-selected={current !== null}
			aria-disabled={off}
			data-month={key}
			data-state={current ?? undefined}
			disabled={off}
			class={cn(
				'h-9 min-w-14 px-2 text-sm transition-colors outline-none',
				'focus-visible:ring-[3px] focus-visible:ring-ring/50',
				current === null && 'rounded-md hover:bg-accent hover:text-accent-foreground',
				current === 'within' && 'bg-accent text-accent-foreground',
				current === 'single' && 'rounded-md bg-primary text-primary-foreground',
				current === 'start' && 'rounded-l-md bg-primary text-primary-foreground',
				current === 'end' && 'rounded-r-md bg-primary text-primary-foreground',
				today === key && current === null && 'font-semibold text-primary',
				off && 'cursor-not-allowed text-muted-foreground/50 hover:bg-transparent'
			)}
			onclick={() => onSelect(key)}
			onmouseenter={() => onHover?.(key)}
			onmouseleave={() => onHover?.(null)}
		>
			{name}
		</button>
	{/each}
</div>
