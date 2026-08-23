<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Checkbox } from '#lib/checkbox';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
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

	const options = [
		{ value: 'true', label: t('dataRenderer.true') },
		{ value: 'false', label: t('dataRenderer.false') }
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
	<Stack gap="sm" class={className}>
		{#each values as checked, index (index)}
			<Inline gap="sm" class="h-8">
				<Inline gap="sm" grow class="min-w-0">
					<Checkbox
						id={id ? `${id}-${index}` : undefined}
						aria-label={t('dataRenderer.booleanValue', { index: index + 1 })}
						{checked}
						{disabled}
						onCheckedChange={(next) => updateArrayItem(index, next)}
					/>
					<span class="text-sm">{checked ? t('dataRenderer.true') : t('dataRenderer.false')}</span>
				</Inline>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="shrink-0"
					aria-label={t('dataRenderer.removeBooleanValue')}
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
			onclick={() => onValueChange?.([...values, false])}
		>
			<Icon icon="lucide:plus" class="size-4" />
			{t('dataRenderer.addValue')}
		</Button>
	</Stack>
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
		<span class="text-sm">{value === true ? t('dataRenderer.true') : t('dataRenderer.false')}</span>
	</div>
{/if}
