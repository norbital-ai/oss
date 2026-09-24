<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'legend',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLLegendElement>> & {
		variant?: 'legend' | 'label';
	} = $props();
</script>

<legend
	bind:this={ref}
	data-slot="field-legend"
	data-variant={variant}
	class={cn(
		// The rendered legend sits outside the fieldset's flex box, so the parent gap cannot reach it.
		'pb-3 font-medium',
		'data-[variant=legend]:text-base',
		'data-[variant=label]:text-sm',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</legend>
