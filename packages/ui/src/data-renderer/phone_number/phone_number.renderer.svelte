<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Inline, Stack } from '#lib/layout';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import PhoneInput from './phone_number.input.svelte';

	let {
		field,
		value,
		id,
		disabled = false,
		placeholder = 'Value…',
		onValueChange,
		locale = 'en-US',
		class: className
	}: DataRendererProps = $props();

	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
	);
	const phonePlaceholder = $derived(placeholder === 'Value…' ? 'Phone number' : placeholder);

	function updateAt(index: number, next: string | null): void {
		const updated = [...values];
		updated[index] = next ?? '';
		onValueChange?.(updated);
	}

	function removeAt(index: number): void {
		onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
	}
</script>

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each values as phone, index (`${index}-${phone}`)}
			<Inline align="start" gap="sm">
				<PhoneInput
					id={id ? `${id}-${index}` : undefined}
					value={phone}
					placeholder={phonePlaceholder}
					{locale}
					{disabled}
					class="min-w-0 flex-1"
					onValueChange={(next) => updateAt(index, next)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="shrink-0"
					aria-label="Remove phone number"
					{disabled}
					onclick={() => removeAt(index)}
				>
					<Icon icon="lucide:x" />
				</Button>
			</Inline>
		{/each}
		<Button
			type="button"
			variant="outline"
			size="sm"
			class="mt-2"
			{disabled}
			onclick={() => onValueChange?.([...values, ''])}
		>
			<Icon icon="lucide:plus" />
			Add phone number
		</Button>
	</Stack>
{:else}
	<PhoneInput
		{id}
		value={typeof value === 'string' ? value : null}
		placeholder={phonePlaceholder}
		{locale}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
