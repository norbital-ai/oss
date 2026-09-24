<script lang="ts">
	import { NavigationMenu as NavigationMenuPrimitive } from 'bits-ui';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: NavigationMenuPrimitive.IndicatorProps = $props();
</script>

<NavigationMenuPrimitive.Indicator
	bind:ref
	data-slot="navigation-menu-indicator"
	class={cn(
		'top-full z-[1] h-1.5 overflow-clip data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:animate-in data-[state=visible]:fade-in',
		className
	)}
	{...restProps}
>
	{#snippet child({ props })}
		<Inline gap="none" align="end" justify="center" {...props}>
			<div class="relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm bg-border shadow-md"></div>
		</Inline>
	{/snippet}
</NavigationMenuPrimitive.Indicator>
