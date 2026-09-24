<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import { Stack } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface QueueProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
	}
	// indexing
</script>

<script lang="ts">
	let { class: className, children, ref = $bindable(null), ...restProps }: QueueProps = $props();
</script>

<Stack
	gap="sm"
	class={cn('border-border bg-background rounded-xl border px-3 pt-2 pb-2 shadow-xs', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
