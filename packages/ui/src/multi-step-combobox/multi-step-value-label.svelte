<script lang="ts" generics="TValueMap extends Record<string, unknown>">
	import { isEqual } from 'es-toolkit/predicate';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { AnyStepOption, SelectionDraft, StepsConfig } from '#lib/multi-step-combobox/types';

	const { t } = useI18n<UiKeys>();

	let {
		selection,
		stepKey,
		keyIndex,
		tone,
		stepSeparator,
		steps
	}: {
		selection: SelectionDraft<TValueMap>;
		stepKey: keyof TValueMap;
		keyIndex: number;
		/** Where the label sits: a trigger badge, or a complete / partial sidebar row. */
		tone: 'badge' | 'complete' | 'partial';
		stepSeparator: string;
		steps: StepsConfig<TValueMap>;
	} = $props();

	const value = $derived(selection[stepKey]);
	const definition = $derived(steps[stepKey]);
	const option = $derived(
		definition.type === 'custom'
			? undefined
			: (definition.options as AnyStepOption<TValueMap>[]).find((candidate) =>
					isEqual(candidate.value, value)
				)
	);
</script>

{#if value != null}
	{#if keyIndex > 0}<span class={tone === 'badge' ? 'opacity-50' : 'opacity-40'}
			>{stepSeparator}</span
		>{/if}
	{#if definition.type === 'custom' && definition.formatSelection}
		{@render definition.formatSelection(value, { compact: true, ...selection })}
	{:else if definition.type === 'custom'}
		<span
			class={{ badge: 'opacity-75', complete: 'opacity-70', partial: 'opacity-60' }[tone]}
			title={JSON.stringify(value)}>{t('common.customFallback')}</span
		>
	{:else if option}
		{#if typeof option.label === 'string'}
			<span>{option.label}</span>
		{:else}
			{@render option.label(value, { compact: true })}
		{/if}
	{:else}
		<span
			class={{ badge: 'opacity-75', complete: 'opacity-70', partial: 'opacity-60' }[tone]}
			title={JSON.stringify(value)}>{t('common.unknownFallback')}</span
		>
	{/if}
{/if}
