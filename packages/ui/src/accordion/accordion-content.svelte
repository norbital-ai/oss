<script lang="ts">
	import { cn } from '#lib/utils';
	import { Accordion as AccordionPrimitive } from 'bits-ui';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	let { class: className, children, ...restProps }: AccordionPrimitive.ContentProps = $props();
</script>

<AccordionPrimitive.Content
	forceMount
	data-slot="accordion-content"
	class={cn('overflow-hidden text-sm', className)}
	{...restProps}
>
	{#snippet child({ props, open })}
		{#if open}
			<div {...props} transition:slide={{ duration: 300, easing: cubicOut }}>
				<div class="pt-0 pb-4">
					{@render children?.()}
				</div>
			</div>
		{/if}
	{/snippet}
</AccordionPrimitive.Content>
