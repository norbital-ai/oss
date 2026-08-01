<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLLiAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface QueueItemProps extends WithElementRef<HTMLLiAttributes> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: QueueItemProps = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<li
	bind:this={ref}
	class={cn(
		'group hover:bg-muted flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</li>
