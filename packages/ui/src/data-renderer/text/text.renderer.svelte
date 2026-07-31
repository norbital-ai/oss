<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
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

	const scalarValue = $derived(value == null || typeof value !== 'string' ? '' : value);
	const values = $derived.by((): Array<string | number> => {
		if (!Array.isArray(value)) return [];
		return value.filter((item): item is string => typeof item === 'string');
	});

	function parseInput(input: HTMLInputElement): string | null | undefined {
		if (!input.value) return field.nullable ? null : undefined;
		return input.value;
	}

	function updateScalar(event: Event & { currentTarget: HTMLInputElement }): void {
		onValueChange?.(parseInput(event.currentTarget));
	}

	function updateArrayItem(index: number, input: HTMLInputElement): void {
		const next = [...values];
		next[index] = input.value;
		onValueChange?.(next);
	}

	function removeArrayItem(index: number): void {
		onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
	}

	function addArrayItem(): void {
		onValueChange?.([...values, '']);
	}
</script>

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each values as item, index (index)}
			<Inline gap="sm">
				<Input
					id={id ? `${id}-${index}` : undefined}
					aria-label={`Value ${index + 1}`}
					type="text"
					value={String(item)}
					{placeholder}
					{disabled}
					class="min-w-0 flex-1"
					oninput={(event) => updateArrayItem(index, event.currentTarget)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="shrink-0"
					aria-label="Remove value"
					{disabled}
					onclick={() => removeArrayItem(index)}
				>
					<Icon icon="lucide:x" class="size-4" />
				</Button>
			</Inline>
		{/each}
		<Button
			type="button"
			variant="outline"
			size="sm"
			class="mt-2"
			{disabled}
			onclick={addArrayItem}
		>
			<Icon icon="lucide:plus" class="size-4" />
			Add value
		</Button>
	</Stack>
{:else}
	<Input
		{id}
		type="text"
		value={scalarValue}
		{placeholder}
		class={className}
		{disabled}
		oninput={updateScalar}
	/>
{/if}
