<script lang="ts">
	import { cn } from '../utils.js';
	import { Accordion as AccordionPrimitive } from 'bits-ui';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { SnakeProps } from '../bits.js';

	let { class: className, children, force_mount = true, hidden_until_found, ...restProps }: SnakeProps<AccordionPrimitive.ContentProps, {
		force_mount: 'forceMount';
		hidden_until_found: 'hiddenUntilFound';
	}> = $props();
</script>

<AccordionPrimitive.Content
	data-slot="accordion-content"
	class={cn('overflow-clip text-sm', className)}
	{...restProps}
	forceMount={force_mount}
	hiddenUntilFound={hidden_until_found}
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
