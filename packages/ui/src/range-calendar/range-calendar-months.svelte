<script lang="ts">
	import { cn } from '#lib/utils';
	import { Switcher } from '#lib/layout';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div bind:this={ref} class={cn('pt-4', className)} {...restProps}>
	<Switcher threshold="compact" gap="md">
		{@render children?.()}
	</Switcher>
</div>
