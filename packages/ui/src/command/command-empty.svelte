<script lang="ts">
	import { cn } from '#lib/utils';
	import { getCommandState } from './command-state.svelte.js';
	import type { CommandEmptyProps } from './types.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		show = undefined,
		...restProps
	}: CommandEmptyProps = $props();

	// Get state from context
	const commandState = getCommandState()();

	// When show is explicitly set, use that
	// Otherwise, show when items are provided but none are visible (filtered out)
	const shouldShowEmpty = $derived(
		show !== undefined
			? show
			: commandState.items.length > 0 && commandState.visibleItems.length === 0
	);
</script>

{#if shouldShowEmpty}
	<div bind:this={ref} class={cn('py-6 text-center text-sm', className)} {...restProps}>
		{#if children}
			{@render children()}
		{/if}
	</div>
{/if}
