<script lang="ts" module>
	import type { WithElementRef } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface QueueItemActionsProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	let { children, ref = $bindable(null), ...restProps }: QueueItemActionsProps = $props();
</script>

<Inline
	gap="xs"
	align="stretch"
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
