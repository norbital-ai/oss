<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	interface ConversationProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
		initial?: ScrollBehavior;
		resize?: ScrollBehavior;
	}
	// indexing
</script>

<script lang="ts">
	import { Stack } from '#lib/layout';
	import { setStickToBottomContext } from './stick-to-bottom-context.svelte.js';

	let {
		class: className,
		children,
		initial = 'smooth',
		resize = 'smooth',
		ref = $bindable(null),
		...restProps
	}: ConversationProps = $props();

	setStickToBottomContext();
</script>

<Stack
	gap="none"
	fill
	class={cn('relative overflow-clip', className)}
	role="log"
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
