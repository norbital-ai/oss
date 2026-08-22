<script lang="ts" generics="TValueMap extends Record<string, unknown>">
	import { isEqual } from 'es-toolkit/predicate';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { AnyStepOption, SelectionDraft, StepsConfig } from '#lib/multi-step-combobox/types';

	const { t } = useI18n<UiKeys>();

	let {
		selection,
		stepKey,
		keyIndex,
		separatorClass,
		fallbackClass,
		stepSeparator,
		steps
	}: {
		selection: SelectionDraft<TValueMap>;
		stepKey: keyof TValueMap;
		keyIndex: number;
		separatorClass: string;
		fallbackClass: string;
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
	{#if keyIndex > 0}<span class={separatorClass}>{stepSeparator}</span>{/if}
	{#if definition.type === 'custom' && definition.formatSelection}
		{@render definition.formatSelection(value, { compact: true, ...selection })}
	{:else if definition.type === 'custom'}
		<span class={fallbackClass} title={JSON.stringify(value)}>{t('common.customFallback')}</span>
	{:else if option}
		{#if typeof option.label === 'string'}
			<span>{option.label}</span>
		{:else}
			{@render option.label(value, { compact: true })}
		{/if}
	{:else}
		<span class={fallbackClass} title={JSON.stringify(value)}>{t('common.unknownFallback')}</span>
	{/if}
{/if}
