<script lang="ts">
	import { NavigationMenu as NavigationMenuPrimitive } from 'bits-ui';
	import { Imposter, Inline } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		wrapperClass,
		...restProps
	}: NavigationMenuPrimitive.ViewportProps & { wrapperClass?: string } = $props();
</script>

<!-- Hangs below the menu bar: `top-full` overrides the corner's top offset. -->
<Imposter
	placement="top-start"
	offset="none"
	layer="modal"
	class={cn('top-full isolate', wrapperClass)}
>
	<Inline gap="none" justify="center" align="stretch">
		<NavigationMenuPrimitive.Viewport
			bind:ref
			data-slot="navigation-menu-viewport"
			class={cn(
				'origin-top-center relative mt-1.5 h-(--bits-navigation-menu-viewport-height) w-full overflow-clip rounded-md border bg-popover text-popover-foreground shadow data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:zoom-in-90 md:w-(--bits-navigation-menu-viewport-width)',
				className
			)}
			{...restProps}
		/>
	</Inline>
</Imposter>
