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

<!-- stupidity:allow UI5; stupidity:allow UI9 -- this leaf component owns a local clip or scroll boundary required by its interaction contract; this local clip boundary contains, rather than duplicates, the descendant scroll owner -->
<div
	bind:this={ref}
	class={cn('relative flex h-full flex-col overflow-hidden', className)}
	role="log"
	{...restProps}
>
	{@render children?.()}
</div>
