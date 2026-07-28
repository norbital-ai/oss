<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface ConversationContentProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { getStickToBottomContext } from './stick-to-bottom-context.svelte.js';
	import { watch } from 'runed';

	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: ConversationContentProps = $props();

	const context = getStickToBottomContext();

	watch(
		() => ref,
		() => {
			if (!ref) return;
			context.setElement(ref);
			// Initial position only — do not re-latch on later ref identity churn.
			context.scrollToBottom('auto');
		}
	);
</script>

<!--
  Scroller is the overflow root; content is the sized box ResizeObserver watches.
  Layout/spacing classes go on content so space-y / gap still apply to messages.
-->
<div
	bind:this={ref}
	class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
	{...restProps}
>
	<div
		data-stick-to-bottom-content
		class={cn('flex min-h-min min-w-0 w-full max-w-full flex-col gap-8 p-4', className)}
	>
		{@render children?.()}
	</div>
</div>
