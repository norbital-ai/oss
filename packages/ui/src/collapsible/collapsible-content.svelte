<script lang="ts">
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';
	import type { ClassValue } from 'clsx';

	let { ref = $bindable(null), class: className, children, ...restProps }: CollapsiblePrimitive.ContentProps = $props();
</script>

<CollapsiblePrimitive.Content
	bind:ref
	forceMount
	data-slot="collapsible-content"
	class={cn('overflow-hidden', className)}
	{...restProps}
>
	{#snippet child({ props, open })}
		<div
			{...props}
			class={cn(
				'grid min-h-0 overflow-hidden transition-[grid-template-rows] duration-300 ease-out',
				open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
				props.class as ClassValue
			)}
		>
			<div class={cn('min-h-0', !open && 'overflow-hidden')} inert={open ? undefined : true}>
				{@render children?.()}
			</div>
		</div>
	{/snippet}
</CollapsiblePrimitive.Content>
