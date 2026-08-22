<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		id,
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const valuePlaceholderText = t('dataRenderer.valuePlaceholder');

	const time = $derived(typeof value === 'string' ? value : '');
	const times = $derived(
		field.array && Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: []
	);

	function updateTime(index: number, next: string): void {
		const updated = [...times];
		updated[index] = next;
		onValueChange?.(updated);
	}

	function removeTime(index: number): void {
		onValueChange?.(times.filter((_, entryIndex) => entryIndex !== index));
	}

	function addTime(): void {
		const now = new Date();
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		onValueChange?.([...times, `${hours}:${minutes}`]);
	}
</script>

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each times as entry, index (`${entry}-${index}`)}
			<Inline gap="sm">
				<Input
					type="time"
					step={60}
					value={entry}
					aria-label={t('dataRenderer.time')}
					{disabled}
					class="min-w-0 flex-1"
					oninput={(event) => updateTime(index, event.currentTarget.value)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label={t('dataRenderer.removeTime')}
					{disabled}
					onclick={() => removeTime(index)}
				>
					<Icon icon="radix-icons:cross-1" class="size-4" />
				</Button>
			</Inline>
		{/each}
		<Button
			type="button"
			variant="outline"
			class="justify-center border-dashed"
			{disabled}
			onclick={addTime}
		>
			<Icon icon="radix-icons:plus" class="size-4" />
			{t('dataRenderer.addTime')}
		</Button>
	</Stack>
{:else}
	<Input
		{id}
		type="time"
		step={60}
		value={time}
		{disabled}
		placeholder={placeholder === valuePlaceholderText ? undefined : placeholder}
		class={className}
		oninput={(event) => onValueChange?.(event.currentTarget.value)}
	/>
{/if}
