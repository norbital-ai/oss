<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import { Stack } from '#lib/layout';
	import type { HTMLAttributes, HTMLLiAttributes } from 'svelte/elements';
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

<Stack
	as="li"
	gap="xs"
	class={cn('group hover:bg-muted rounded-md px-3 py-1 text-sm transition-colors', className)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLLIElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
