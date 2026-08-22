<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import {
		indicatorVariants,
		type IndicatorPosition,
		type IndicatorSize,
		type IndicatorVariant
	} from '#lib/indicator/indicator-variants';

	let {
		variant = 'default',
		size = 'md',
		position = 'top-right',
		animated = true,
		visible = true,
		class: className,
		children,
		wrapperClass,
		...restProps
	}: {
		wrapperClass?: string;
		variant?: IndicatorVariant;
		size?: IndicatorSize;
		position?: IndicatorPosition;
		animated?: boolean;
		visible?: boolean;
		class?: string;
		children: Snippet;
	} & Record<string, unknown> = $props();
</script>

<div class={cn('relative inline-block border-brand', wrapperClass)}>
	{@render children()}
	{#if visible}
		<span
			class={cn(indicatorVariants({ variant, size, position, animated }), className)}
			aria-hidden="true"
			{...restProps}
		></span>
	{/if}
</div>
