<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Input } from '#lib/input';
	import { Root as Progress } from '#lib/progress';
	import { cn } from '#lib/utils';
	import type { DataRendererProps } from '../../data-renderer.types.js';

	interface Props extends DataRendererProps {
		denominator: number;
	}

	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = 'No progress',
		onValueChange,
		locale = 'en-US',
		denominator,
		class: className
	}: Props = $props();

	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
	);
	const scalarValue = $derived(typeof value === 'number' ? value : null);
	const formatter = $derived(new Intl.NumberFormat(locale));

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
	<div class="flex min-w-0 flex-1 items-center gap-3">
		<Progress value={visualValue(progressValue)} max={denominator} class="min-w-20 flex-1" />
		<span class="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
			{formatter.format(progressValue)} / {formatter.format(denominator)}
		</span>
	</div>
{/snippet}

{#if field.array}
	<div class={cn('space-y-2', className)}>
		{#each values as item, index (index)}
			<div class="flex min-h-8 items-center gap-3">
				{#if mode === 'edit'}
					<Input
						id={id ? `${id}-${index}` : undefined}
						aria-label={`Progress ${index + 1}`}
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
						aria-label="Remove progress value"
						{disabled}
						onclick={() => onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index))}
					>
						<Icon icon="lucide:x" class="size-4" />
					</Button>
				{/if}
			</div>
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
				Add progress
			</Button>
		{/if}
	</div>
{:else if scalarValue == null && mode === 'display'}
	<span class={cn('text-sm text-muted-foreground', className)}>{placeholder}</span>
{:else if mode === 'edit'}
	<div class={cn('flex items-center gap-3', className)}>
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
	</div>
{:else}
	<div class={className}>{@render progress(scalarValue ?? 0)}</div>
{/if}
