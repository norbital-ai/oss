<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface TimelineImageProps extends HTMLAttributes<HTMLDivElement> {
		/**
		 * Optional caption text for the image
		 */
		caption?: string;
		/**
		 * Children content (typically an image element)
		 */
		children: Snippet;
		/**
		 * Additional CSS classes
		 */
		class?: string;
	}

	let { caption, children, class: className, ...restProps }: TimelineImageProps = $props();
</script>

<div class={cn('mt-2 space-y-2', className)} {...restProps}>
	<div
		class="relative flex max-h-88 items-center justify-center overflow-hidden rounded-lg bg-muted p-3"
	>
		{@render children()}
	</div>
	{#if caption}
		<p class="text-xs text-muted-foreground">{caption}</p>
	{/if}
</div>
