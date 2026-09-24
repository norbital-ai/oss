<script lang="ts">
	import { Cluster } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes, HTMLOlAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLOlAttributes> = $props();
</script>

<Cluster
	as="ol"
	gap="sm"
	class={cn('wrap-wrap-break-word text-sm text-muted-foreground', className)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLOListElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Cluster>
