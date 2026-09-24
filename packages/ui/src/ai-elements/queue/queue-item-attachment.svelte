<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import { Cluster } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface QueueItemAttachmentProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: QueueItemAttachmentProps = $props();
</script>

<Cluster
	gap="sm"
	align="start"
	class={cn('pt-1', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Cluster>
