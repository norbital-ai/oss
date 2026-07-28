<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef, WithoutChildren } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> = $props();
</script>

<div
	bind:this={ref}
	class={cn('animate-pulse motion-reduce:animate-none rounded-md bg-muted', className)}
	{...restProps}
></div>
