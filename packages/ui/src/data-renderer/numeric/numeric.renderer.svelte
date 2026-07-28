<script lang="ts">
	import type { NumericRendererVariant } from '@norbital-ai/platform-utils/collection';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import NumberView from './views/number.view.svelte';
	import ProgressView from './views/progress.view.svelte';
	import StarRatingView from './views/star_rating.view.svelte';

	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = 'Value…',
		onValueChange,
		locale = 'en-US',
		class: className
	}: DataRendererProps = $props();

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
		{locale}
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
		{locale}
		class={className}
	/>
{/if}
