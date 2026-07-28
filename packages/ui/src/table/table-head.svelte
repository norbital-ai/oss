<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { Action } from 'svelte/action';
	import type { HTMLThAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		action,
		...restProps
	}: WithElementRef<HTMLThAttributes> & {
		action?: Action<HTMLDivElement>;
	} = $props();
</script>

{#if action}
	<th
		use:action
		bind:this={ref}
		class={cn(
			'h-8 px-2 text-left align-middle font-medium text-muted-foreground shadow-sm [&:has([role=checkbox])]:pr-1',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</th>
{:else}
	<th
		bind:this={ref}
		class={cn(
			'h-8 px-2 text-left align-middle font-medium text-muted-foreground shadow-sm [&:has([role=checkbox])]:pr-1',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</th>
{/if}
