<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Checkbox } from '#lib/checkbox';
	import { Combobox } from '#lib/combobox';
	import { cn } from '#lib/utils';
	import type { DataRendererProps } from '../data-renderer.types.js';

	let {
		field,
		value,
		id,
		disabled = false,
		placeholder = 'Value…',
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const options = [
		{ value: 'true', label: 'Yes' },
		{ value: 'false', label: 'No' }
	];
	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is boolean => typeof item === 'boolean') : []
	);

	function updateArrayItem(index: number, checked: boolean): void {
		const next = [...values];
		next[index] = checked;
		onValueChange?.(next);
	}

	function removeArrayItem(index: number): void {
		onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
	}
</script>

{#if field.array}
	<div class={className}>
		<div class="space-y-2">
			{#each values as checked, index (index)}
				<div class="flex h-8 items-center gap-2">
					<div class="flex min-w-0 flex-1 items-center gap-2">
						<Checkbox
							id={id ? `${id}-${index}` : undefined}
							aria-label={`Boolean value ${index + 1}`}
							{checked}
							{disabled}
							onCheckedChange={(next) => updateArrayItem(index, next)}
						/>
						<span class="text-sm">{checked ? 'Yes' : 'No'}</span>
					</div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						class="shrink-0"
						aria-label="Remove boolean value"
						{disabled}
						onclick={() => removeArrayItem(index)}
					>
						<Icon icon="lucide:x" class="size-4" />
					</Button>
				</div>
			{/each}
		</div>
		<Button
			type="button"
			variant="outline"
			size="sm"
			class="mt-2"
			{disabled}
			onclick={() => onValueChange?.([...values, false])}
		>
			<Icon icon="lucide:plus" class="size-4" />
			Add value
		</Button>
	</div>
{:else if field.nullable}
	<Combobox
		{options}
		value={typeof value === 'boolean' ? String(value) : null}
		emptyPlaceholder={placeholder}
		allowClear={true}
		searchable={false}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next == null ? null : next === 'true')}
	/>
{:else}
	<div class={cn('flex h-8 items-center gap-2', className)}>
		<Checkbox
			{id}
			checked={value === true}
			{disabled}
			onCheckedChange={(checked) => onValueChange?.(checked)}
		/>
		<span class="text-sm">{value === true ? 'Yes' : 'No'}</span>
	</div>
{/if}
