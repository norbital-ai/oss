<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Input } from '#lib/input';
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

	const time = $derived(typeof value === 'string' ? value : '');
	const times = $derived(
		field.array && Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: []
	);

	function emitTimes(next: string[]): void {
		onValueChange?.(next);
	}

	function updateTime(index: number, next: string): void {
		const updated = [...times];
		updated[index] = next;
		emitTimes(updated);
	}

	function removeTime(index: number): void {
		emitTimes(times.filter((_, entryIndex) => entryIndex !== index));
	}

	function addTime(): void {
		const now = new Date();
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		emitTimes([...times, `${hours}:${minutes}`]);
	}
</script>

{#if field.array}
	<div class={cn('grid min-w-0 gap-2', className)}>
		{#each times as entry, index (`${entry}-${index}`)}
			<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
				<Input
					type="time"
					step={60}
					value={entry}
					aria-label="Time"
					{disabled}
					oninput={(event) => updateTime(index, event.currentTarget.value)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label="Remove time"
					{disabled}
					onclick={() => removeTime(index)}
				>
					<Icon icon="radix-icons:cross-1" class="size-4" />
				</Button>
			</div>
		{/each}
		<Button
			type="button"
			variant="outline"
			class="justify-center border-dashed"
			{disabled}
			onclick={addTime}
		>
			<Icon icon="radix-icons:plus" class="size-4" />
			Add time
		</Button>
	</div>
{:else}
	<Input
		{id}
		type="time"
		step={60}
		value={time}
		{disabled}
		placeholder={placeholder === 'Value…' ? undefined : placeholder}
		class={className}
		oninput={(event) => onValueChange?.(event.currentTarget.value)}
	/>
{/if}
