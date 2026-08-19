<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Stack } from '#lib/layout';
	import { Star, StarRating } from '#lib/star-rating';
	import { cn } from '#lib/utils';
	import type { DataRendererProps } from '../../data-renderer.types.js';

	interface Props extends DataRendererProps {
		max: number;
	}

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.noRating'),
		onValueChange,
		max,
		class: className
	}: Props = $props();

	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
	);
	const scalarValue = $derived(typeof value === 'number' ? value : null);

	function normalized(next: number): number {
		return Math.min(max, Math.max(0, next));
	}

	function updateArrayItem(index: number, nextValue: number): void {
		const next = [...values];
		next[index] = normalized(nextValue);
		onValueChange?.(next);
	}
</script>

{#snippet rating(ratingValue: number, readonly: boolean, onChange?: (next: number) => void)}
	<Inline gap="sm">
		<StarRating
			value={normalized(ratingValue)}
			{max}
			{readonly}
			{disabled}
			onValueChange={onChange}
			class="shrink-0"
		>
			{#snippet children({ items })}
				{#each items as item (item.index)}
					<Star {...item} class="size-5" />
				{/each}
			{/snippet}
		</StarRating>
		<span class="whitespace-nowrap text-meta tabular-nums">
			{normalized(ratingValue)}/{max}
		</span>
	</Inline>
{/snippet}

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each values as item, index (index)}
			<Inline justify="between" gap="md" class="min-h-8">
				{@render rating(item, mode === 'display', (next) => updateArrayItem(index, next))}
				{#if mode === 'edit'}
					<Button
						type="button"
						variant="outline"
						size="icon"
						class="shrink-0"
						aria-label={t('dataRenderer.removeRating')}
						{disabled}
						onclick={() => onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index))}
					>
						<Icon icon="lucide:x" class="size-4" />
					</Button>
				{/if}
			</Inline>
		{/each}
		{#if values.length === 0 && mode === 'display'}
			<span class="text-sm text-muted-foreground">{placeholder}</span>
		{:else if mode === 'edit'}
			<Button
				type="button"
				variant="outline"
				size="sm"
				{disabled}
				onclick={() => onValueChange?.([...values, 0])}
			>
				<Icon icon="lucide:plus" class="size-4" />
				{t('dataRenderer.addRating')}
			</Button>
		{/if}
	</Stack>
{:else if scalarValue == null && mode === 'display'}
	<span class={cn('text-sm text-muted-foreground', className)}>{placeholder}</span>
{:else}
	<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
	<div class={cn('flex items-center gap-2', className)}>
		{@render rating(scalarValue ?? 0, mode === 'display', (next) =>
			onValueChange?.(normalized(next))
		)}
		{#if mode === 'edit' && field.nullable && scalarValue != null}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={t('dataRenderer.clearRating')}
				{disabled}
				onclick={() => onValueChange?.(null)}
			>
				<Icon icon="lucide:x" class="size-4" />
			</Button>
		{/if}
	</div>
{/if}
