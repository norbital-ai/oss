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
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		locale,
		class: className
	}: DataRendererProps = $props();
	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);

	const values = $derived(
		Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
	);
	const scalarValue = $derived(typeof value === 'number' ? String(value) : '');
	const step = $derived(field.kind === 'integer' ? 1 : 'any');
	const formatted = $derived.by(() => {
		const formatter = new Intl.NumberFormat(localeEffective);
		if (field.array) return values.map((item) => formatter.format(item)).join(', ');
		return typeof value === 'number' ? formatter.format(value) : placeholder;
	});

	function parseInput(input: HTMLInputElement): number | null | undefined {
		if (!input.value) return field.nullable ? null : undefined;
		return input.valueAsNumber;
	}

	function updateArrayItem(index: number, input: HTMLInputElement): void {
		if (!input.value) {
			onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
			return;
		}
		const next = [...values];
		next[index] = input.valueAsNumber;
		onValueChange?.(next);
	}
</script>

{#if mode === 'display'}
	<span class={cn('block truncate', value == null && 'text-muted-foreground', className)}>
		{formatted}
	</span>
{:else if field.array}
	<Stack gap="sm" class={className}>
		{#each values as item, index (index)}
			<Inline gap="sm">
				<Input
					id={id ? `${id}-${index}` : undefined}
					aria-label={t('dataRenderer.valueIndex', { index: index + 1 })}
					type="number"
					{step}
					value={String(item)}
					{placeholder}
					{disabled}
					class="min-w-0 flex-1"
					onchange={(event) => updateArrayItem(index, event.currentTarget)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="shrink-0"
					aria-label={t('dataRenderer.removeValue')}
					{disabled}
					onclick={() => onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index))}
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
			onclick={() => onValueChange?.([...values, 0])}
		>
			<Icon icon="lucide:plus" class="size-4" />
			{t('dataRenderer.addValue')}
		</Button>
	</Stack>
{:else}
	<Input
		{id}
		type="number"
		{step}
		value={scalarValue}
		{placeholder}
		class={className}
		{disabled}
		oninput={(event) => onValueChange?.(parseInput(event.currentTarget))}
	/>
{/if}
