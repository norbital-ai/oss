<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<Inline
	gap="sm"
	data-slot="item-title"
	class={cn('w-fit text-sm leading-snug font-medium', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
