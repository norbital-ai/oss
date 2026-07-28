<script lang="ts">
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';

	let {
		selectedYear,
		minYear,
		maxYear,
		onSelect
	}: {
		selectedYear: number | null;
		minYear?: number;
		maxYear?: number;
		onSelect: (year: number) => void;
	} = $props();

	// svelte-ignore state_referenced_locally -- selection intentionally seeds the page shown when this popover content mounts.
	const initialYear = selectedYear ?? new Date().getUTCFullYear();
	let pageStart = $state(initialYear - (initialYear % 12));
</script>

<div class="mb-2 flex h-8 items-center justify-between">
	<button
		type="button"
		class={buttonVariants({ variant: 'ghost', size: 'icon', class: 'size-8' })}
		aria-label="Show previous years"
		disabled={minYear != null && pageStart <= minYear}
		onclick={() => (pageStart -= 12)}
	>
		<Icon icon="lucide:chevron-left" class="size-4" />
	</button>
	<span class="text-xs font-medium tabular-nums">{pageStart}–{pageStart + 11}</span>
	<button
		type="button"
		class={buttonVariants({ variant: 'ghost', size: 'icon', class: 'size-8' })}
		aria-label="Show next years"
		disabled={maxYear != null && pageStart + 11 >= maxYear}
		onclick={() => (pageStart += 12)}
	>
		<Icon icon="lucide:chevron-right" class="size-4" />
	</button>
</div>
<div class="grid grid-cols-3 gap-1" role="grid" aria-label="Choose year">
	{#each Array.from({ length: 12 }, (_, index) => pageStart + index) as year (year)}
		<button
			type="button"
			class={cn(
				buttonVariants({ variant: 'ghost', size: 'sm' }),
				'h-8 justify-center text-xs font-normal tabular-nums',
				selectedYear === year && 'bg-primary text-primary-foreground hover:bg-primary/90'
			)}
			aria-pressed={selectedYear === year}
			disabled={(minYear != null && year < minYear) || (maxYear != null && year > maxYear)}
			onclick={() => onSelect(year)}
		>
			{year}
		</button>
	{/each}
</div>
