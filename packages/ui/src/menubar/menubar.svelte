<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { Menubar as MenubarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: MenubarPrimitive.RootProps = $props();
</script>

<MenubarPrimitive.Root
	bind:ref
	class={cn('h-8 rounded-md border bg-background p-1', className)}
	{...restProps}
>
	{#snippet child({ props })}
		<Inline gap="xs" {...props}>{@render children?.()}</Inline>
	{/snippet}
</MenubarPrimitive.Root>
