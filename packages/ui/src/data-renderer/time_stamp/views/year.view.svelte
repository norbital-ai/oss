<script lang="ts">
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Columns, Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

	const { t } = useI18n<UiKeys>();

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

<Stack gap="sm">
	<Inline justify="between" gap="none" class="h-8">
		<button
			type="button"
			class={buttonVariants({ variant: 'ghost', size: 'icon', class: 'size-8' })}
			aria-label={t('dataRenderer.prevYears')}
			disabled={minYear != null && pageStart <= minYear}
			onclick={() => (pageStart -= 12)}
		>
			<Icon icon="lucide:chevron-left" class="size-4" />
		</button>
		<span class="text-xs font-medium tabular-nums">{pageStart}–{pageStart + 11}</span>
		<button
			type="button"
			class={buttonVariants({ variant: 'ghost', size: 'icon', class: 'size-8' })}
			aria-label={t('dataRenderer.nextYears')}
			disabled={maxYear != null && pageStart + 11 >= maxYear}
			onclick={() => (pageStart += 12)}
		>
			<Icon icon="lucide:chevron-right" class="size-4" />
		</button>
	</Inline>
	<Columns count={3} gap="xs" role="grid" aria-label={t('dataRenderer.chooseYear')}>
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
	</Columns>
</Stack>
