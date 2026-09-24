<script lang="ts">
	import { Columns, Stack } from '#lib/layout';
	import { getCommandState } from './command-state.svelte.js';
	import type { CommandGroupItemsProps } from '#lib/command/types';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandGroupItemsProps = $props();

	// Get state from context (getter pattern)
	const commandState = getCommandState()();
</script>

{#snippet items()}
	{@render children?.()}
{/snippet}

{#if commandState.columns}
	<Columns
		bind:ref
		count={commandState.columns}
		gap="none"
		collapse="none"
		class={className}
		{...restProps}
		children={items}
	/>
{:else}
	<Stack bind:ref gap="none" class={className} {...restProps} children={items} />
{/if}
