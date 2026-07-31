<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import DateView from './date.view.svelte';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
	import { fromLocalDateTimeParts, toLocalDateTimeParts } from '../timestamp.utils.js';

	let {
		value,
		multiple = false,
		disabled = false,
		placeholder = 'Select date and time',
		class: className,
		onValueChange
	}: {
		value: string | string[] | null;
		multiple?: boolean;
		disabled?: boolean;
		placeholder?: string;
		class?: string;
		onValueChange?: (value: string | string[] | null) => void;
	} = $props();

	const values = $derived(
		multiple ? (Array.isArray(value) ? value : []) : typeof value === 'string' ? [value] : []
	);

	function emit(next: string[]): void {
		onValueChange?.(multiple ? next : (next[0] ?? null));
	}

	function replaceAt(index: number, next: string): void {
		const updated = [...values];
		updated[index] = next;
		emit(updated);
	}

	function removeAt(index: number): void {
		emit(values.filter((_, itemIndex) => itemIndex !== index));
	}

	function updateDate(index: number, nextDate: string | null): void {
		if (!nextDate) {
			removeAt(index);
			return;
		}
		const selected = toLocalDateTimeParts(nextDate);
		const current = toLocalDateTimeParts(values[index]);
		if (!selected) return;
		const next = fromLocalDateTimeParts(selected.date, current?.time ?? '00:00');
		if (next) replaceAt(index, next);
	}

	function updateTime(index: number, time: string): void {
		const current = toLocalDateTimeParts(values[index]);
		if (!current) return;
		const next = fromLocalDateTimeParts(current.date, time);
		if (next) replaceAt(index, next);
	}

	function addValue(): void {
		const now = new Date();
		now.setSeconds(0, 0);
		emit([...values, now.toISOString()]);
	}
</script>

<Stack gap="sm" class={className}>
	{#each values as entry, index (`${entry}-${index}`)}
		{@const parts = toLocalDateTimeParts(entry)}
		<!-- stupidity:allow UI10 -- input-group chip boundary -->
		<Inline
			align="stretch"
			gap="none"
			class="min-w-0 overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:ring-2 focus-within:ring-ring"
		>
			<DateView
				value={entry}
				multi={false}
				{placeholder}
				{disabled}
				borderless={true}
				class="min-w-0 flex-1"
				onValueChange={(next) => updateDate(index, next)}
			/>
			<div class="relative w-28 shrink-0 border-l border-input">
				<Icon
					icon="lucide:clock-3"
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="time"
					value={parts?.time ?? ''}
					aria-label="Time"
					class="border-0 pl-8 shadow-none focus-visible:ring-0"
					{disabled}
					oninput={(event) => updateTime(index, event.currentTarget.value)}
				/>
			</div>
			{#if multiple}
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label="Remove date and time"
					{disabled}
					onclick={() => removeAt(index)}
				>
					<Icon icon="radix-icons:cross-1" class="size-4" />
				</Button>
			{/if}
		</Inline>
	{/each}

	{#if values.length === 0 && !multiple}
		<!-- stupidity:allow UI10 -- input-group chip boundary -->
		<Inline
			align="stretch"
			gap="none"
			class="min-w-0 overflow-hidden rounded-md border border-input bg-background shadow-xs"
		>
			<DateView
				value={null}
				multi={false}
				{placeholder}
				{disabled}
				borderless={true}
				class="min-w-0 flex-1"
				onValueChange={(next) => updateDate(0, next)}
			/>
			<div class="relative w-28 shrink-0 border-l border-input">
				<Icon
					icon="lucide:clock-3"
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="time"
					value=""
					aria-label="Time"
					class="border-0 pl-8 shadow-none focus-visible:ring-0"
					disabled
				/>
			</div>
		</Inline>
	{/if}

	{#if multiple}
		<Button
			type="button"
			variant="outline"
			class="justify-center border-dashed"
			{disabled}
			onclick={addValue}
		>
			<Icon icon="radix-icons:plus" class="size-4" />
			Add date and time
		</Button>
	{/if}
</Stack>
