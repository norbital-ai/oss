<script lang="ts">
	/**
	 * This component handles leaf nodes (nodes without children).
	 * It renders a simple non-collapsible row in the tree.
	 */
	import { cn } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		/** Content snippet for the leaf node */
		content: Snippet;
	}

	let { content, class: className, ...rest }: Props = $props();
</script>

<Inline gap="xs" class={cn('pl-[3px]', className)} {...rest}>
	{@render content()}
</Inline>
