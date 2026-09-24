<script lang="ts">
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';
	import type { ClassValue } from 'clsx';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CollapsiblePrimitive.ContentProps = $props();
</script>

<CollapsiblePrimitive.Content
	bind:ref
	forceMount
	data-slot="collapsible-content"
	class={cn('overflow-clip', className)}
	{...restProps}
>
	{#snippet child({ props, open })}
		<div
			{...props}
			class={cn(
				// repository-health:allow UI6 -- the height transition animates `grid-template-rows` from 0fr to 1fr; no primitive animates its own track
				'grid min-h-0 overflow-clip transition-[grid-template-rows] duration-300 ease-out',
				// repository-health:allow UI27 -- the animated 0fr/1fr row track of the same disclosure (see UI6 above)
				open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
				props.class as ClassValue
			)}
		>
			<div class={cn('min-h-0', !open && 'overflow-clip')} inert={open ? undefined : true}>
				{@render children?.()}
			</div>
		</div>
	{/snippet}
</CollapsiblePrimitive.Content>
