<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CommandShortcutProps } from './types.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandShortcutProps = $props();
</script>

<span
	bind:this={ref}
	class={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{/if}
</span>
