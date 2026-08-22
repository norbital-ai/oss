<script lang="ts">
	import type { NumericRendererVariant } from '@norbital-ai/std/collection';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import NumberView from './views/number.view.svelte';
	import ProgressView from './views/progress.view.svelte';
	import StarRatingView from './views/star_rating.view.svelte';

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

	const variant = $derived.by((): NumericRendererVariant => {
		const configured = field.variant ?? { type: 'number' as const };
		switch (configured.type) {
			case 'number':
			case 'star-rating':
			case 'progress':
				return configured;
			default:
				configured satisfies never;
				throw new Error('Unsupported numeric renderer variant.');
		}
	});
</script>

{#if variant.type === 'star-rating'}
	<StarRatingView
		{field}
		{value}
		{id}
		{mode}
		{disabled}
		{placeholder}
		{onValueChange}
		max={variant.max}
		class={className}
	/>
{:else if variant.type === 'progress'}
	<ProgressView
		{field}
		{value}
		{id}
		{mode}
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		denominator={variant.denominator}
		class={className}
	/>
{:else}
	<NumberView
		{field}
		{value}
		{id}
		{mode}
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		class={className}
	/>
{/if}
