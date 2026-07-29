<script lang="ts">
	import { cn } from '#lib/utils';
	import { Tabs as TabsPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		value,
		active = false,
		lazyLoad = true,
		keepAlive = false,
		animate = true,
		contentPadding = true,
		children,
		...restProps
	}: TabsPrimitive.ContentProps & {
		active?: boolean;
		lazyLoad?: boolean;
		keepAlive?: boolean;
		animate?: boolean;
		contentPadding?: boolean;
	} = $props();
</script>

<TabsPrimitive.Content
	bind:ref
	class={cn(
		'h-full min-h-0 min-w-0 overflow-x-clip overflow-y-auto overscroll-contain [scrollbar-gutter:stable] ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none',
		contentPadding && 'px-4 py-2 sm:px-6',
		animate && [
			'data-[state=active]:animate-in data-[state=active]:fade-in-50 data-[state=active]:blur-in-xs',
			'motion-safe:data-[state=active]:duration-300',
			'[--enter-ease:cubic-bezier(0.34,1.56,0.64,1)]'
		],
		className
	)}
	{...restProps}
	{value}
>
	{#if !lazyLoad || active || keepAlive}
		{#if keepAlive}
			<div hidden={!active} class="h-full min-h-0 min-w-0 overflow-clip">
				{@render children?.()}
			</div>
		{:else}
			{@render children?.()}
		{/if}
	{/if}
</TabsPrimitive.Content>
