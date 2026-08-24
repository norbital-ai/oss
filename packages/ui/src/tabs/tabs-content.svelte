<script lang="ts">
	import { cn } from '#lib/utils';
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { INSET_CLASS } from '#lib/layout';

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
	/**
	 * Sticky for `keepAlive`: a panel that has been shown once stays mounted after it is hidden.
	 * The latch is set by the attachment on the kept-alive wrapper, which only ever mounts while
	 * the panel is active — so no effect has to watch `active` to notice.
	 */
	let visited = $state(false);
	const markVisited = () => {
		visited = true;
	};
</script>

<TabsPrimitive.Content
	bind:ref
	class={cn(
		'h-full min-h-0 min-w-0 overflow-clip ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none',
		contentPadding && INSET_CLASS,
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
	{#if !lazyLoad || active || (keepAlive && visited)}
		{#if keepAlive}
			<div hidden={!active} class="h-full min-h-0 min-w-0 overflow-clip" {@attach markVisited}>
				{@render children?.()}
			</div>
		{:else}
			{@render children?.()}
		{/if}
	{/if}
</TabsPrimitive.Content>
