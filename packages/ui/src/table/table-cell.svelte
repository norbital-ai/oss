<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { Action } from 'svelte/action';
	import type { HTMLTdAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		action,
		...restProps
	}: WithElementRef<HTMLTdAttributes> & { action?: Action<HTMLDivElement> } = $props();
</script>

{#if action}
	<td
		use:action
		bind:this={ref}
		class={cn(
			'p-2 align-middle hover:bg-muted data-[state=selected]:bg-muted [&:has([role=checkbox])]:pr-1',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</td>
{:else}
	<td
		bind:this={ref}
		class={cn(
			'p-2 align-middle hover:bg-muted data-[state=selected]:bg-muted [&:has([role=checkbox])]:pr-1',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</td>
{/if}
