<script lang="ts">
	import { cn } from '#lib/utils';
	import { getCommandState } from './command-state.svelte.js';
	import type { CommandGroupItemsProps } from './types.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandGroupItemsProps = $props();

	// Get state from context (getter pattern)
	const commandState = getCommandState()();
</script>

<div
	bind:this={ref}
	class={cn(
		commandState.columns ? `grid grid-cols-${commandState.columns}` : 'flex flex-col',
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{/if}
</div>
