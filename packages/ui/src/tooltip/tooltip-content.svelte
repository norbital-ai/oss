<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import { cn } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 0,
		side = 'top',
		children,
		arrowClasses,
		...restProps
	}: TooltipPrimitive.ContentProps & {
		/** The Bits UI arrow uses currentColor for its fill. */
		arrowClasses?: string;
	} = $props();
</script>

<TooltipPrimitive.Portal>
	<TooltipPrimitive.Content
		bind:ref
		data-slot="tooltip-content"
		{sideOffset}
		{side}
		class={cn(
			'z-50 w-fit origin-(--bits-tooltip-content-transform-origin) animate-in rounded-md bg-primary px-3 py-1.5 text-xs text-balance text-primary-foreground fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<TooltipPrimitive.Arrow class={cn('z-50 text-primary', arrowClasses)} />
	</TooltipPrimitive.Content>
</TooltipPrimitive.Portal>
