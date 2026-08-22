<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	interface ConversationContentProps extends WithElementRef<HTMLAttributes<HTMLElement>> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { Scroll, Stack } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { getStickToBottomContext } from './stick-to-bottom-context.svelte.js';
	import { watch } from 'runed';

	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: ConversationContentProps = $props();

	const context = getStickToBottomContext();
	const { t } = useI18n<UiKeys>();

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

<Scroll
	axis="y"
	name={t('misc.conversationMessages')}
	grow
	class="min-h-0 min-w-0"
	bind:ref
	{...restProps}
>
	<Stack
		gap="xl"
		data-stick-to-bottom-content
		class={cn('min-h-min min-w-0 max-w-full p-4', className)}
	>
		{@render children?.()}
	</Stack>
</Scroll>
