<script lang="ts">
	import { NavigationMenu as NavigationMenuPrimitive } from 'bits-ui';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: NavigationMenuPrimitive.ListProps = $props();
</script>

<NavigationMenuPrimitive.List
	bind:ref
	data-slot="navigation-menu-list"
	class={cn('group list-none', className)}
	{...restProps}
>
	{#snippet child({ props })}
		<Inline as="ul" gap="xs" justify="center" grow {...props}>{@render children?.()}</Inline>
	{/snippet}
</NavigationMenuPrimitive.List>
