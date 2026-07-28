<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CommandLoadingProps } from './types.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandLoadingProps = $props();
</script>

<div bind:this={ref} class={cn('py-6 text-center text-sm', className)} {...restProps}>
	{#if children}
		{@render children()}
	{/if}
</div>
