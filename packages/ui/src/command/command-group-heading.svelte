<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CommandGroupHeadingProps } from '#lib/command/types';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandGroupHeadingProps = $props();
</script>

<div
	bind:this={ref}
	class={cn('px-2 py-1.5 text-sm font-medium text-muted-foreground underline', className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{/if}
</div>
