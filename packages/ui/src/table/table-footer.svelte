<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLTableSectionElement>> = $props();
</script>

<tfoot
	bind:this={ref}
	class={cn('bg-primary font-medium text-primary-foreground', className)}
	{...restProps}
>
	{@render children?.()}
</tfoot>
