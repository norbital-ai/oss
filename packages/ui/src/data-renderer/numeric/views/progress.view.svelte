<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
	import { Root as Progress } from '#lib/progress';
	import { cn } from '#lib/utils';
	import type { DataRendererProps } from '../../data-renderer.types.js';

	interface Props extends DataRendererProps {
		denominator: number;
	}

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.noProgress'),
		onValueChange,
		locale,
		denominator,
		class: className
	}: Props = $props();
	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);

	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
	);
	const scalarValue = $derived(typeof value === 'number' ? value : null);
	const formatter = $derived(new Intl.NumberFormat(localeEffective));

	function visualValue(next: number): number {
		return Math.min(denominator, Math.max(0, next));
	}

	function parsed(input: HTMLInputElement): number | null | undefined {
		if (!input.value) return field.nullable ? null : undefined;
		return Math.min(denominator, Math.max(0, input.valueAsNumber));
	}

	function updateArrayItem(index: number, input: HTMLInputElement): void {
		if (!input.value) {
			onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
			return;
		}
		const next = [...values];
		next[index] = Math.min(denominator, Math.max(0, input.valueAsNumber));
		onValueChange?.(next);
	}
</script>

{#snippet progress(progressValue: number)}
	<Inline gap="md" grow class="min-w-0">
		<Progress value={visualValue(progressValue)} max={denominator} class="min-w-20 flex-1" />
		<span class="whitespace-nowrap text-meta tabular-nums">
			{formatter.format(progressValue)} / {formatter.format(denominator)}
		</span>
	</Inline>
{/snippet}

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each values as item, index (index)}
			<Inline gap="md" class="min-h-8">
				{#if mode === 'edit'}
					<Input
						id={id ? `${id}-${index}` : undefined}
						aria-label={t('dataRenderer.progressIndex', { index: index + 1 })}
						type="number"
						min={0}
						max={denominator}
						step="any"
						value={String(item)}
						{disabled}
						class="w-28 shrink-0"
						oninput={(event) => updateArrayItem(index, event.currentTarget)}
					/>
				{/if}
				{@render progress(item)}
				{#if mode === 'edit'}
					<Button
						type="button"
						variant="outline"
						size="icon"
						class="shrink-0"
						aria-label={t('dataRenderer.removeProgress')}
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
				{t('dataRenderer.addProgress')}
			</Button>
		{/if}
	</Stack>
{:else if scalarValue == null && mode === 'display'}
	<span class={cn('text-sm text-muted-foreground', className)}>{placeholder}</span>
{:else if mode === 'edit'}
	<Inline gap="md" class={className}>
		<Input
			{id}
			type="number"
			min={0}
			max={denominator}
			step="any"
			value={scalarValue == null ? '' : String(scalarValue)}
			{placeholder}
			{disabled}
			class="w-28 shrink-0"
			oninput={(event) => onValueChange?.(parsed(event.currentTarget))}
		/>
		{@render progress(scalarValue ?? 0)}
	</Inline>
{:else}
	<div class={className}>{@render progress(scalarValue ?? 0)}</div>
{/if}
