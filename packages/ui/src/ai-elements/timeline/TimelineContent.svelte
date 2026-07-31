<script lang="ts">
	import { CollapsibleContent } from '#lib/collapsible';
	import { Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { getTimelineContext } from './timeline-context.svelte.js';

	interface TimelineContentProps {
		/**
		 * Children content
		 */
		children: Snippet;
		/**
		 * Constrain height and enable vertical scrolling for long content.
		 */
		scrollable?: boolean;
		/**
		 * Additional CSS classes
		 */
		class?: string;
	}

	let { children, scrollable = false, class: className }: TimelineContentProps = $props();

	const context = getTimelineContext()();
</script>

<CollapsibleContent
	class={cn(
		'text-foreground outline-none',
		'duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none',
		'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1',
		'data-[state=open]:mt-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1',
		scrollable &&
			'data-[state=open]:max-h-[min(20rem,45vh)] data-[state=open]:overflow-y-auto data-[state=open]:rounded-md data-[state=open]:border data-[state=open]:border-border/30 data-[state=open]:px-2 data-[state=open]:py-1.5',
		className
	)}
>
	<Stack gap="sm">{@render children()}</Stack>
</CollapsibleContent>
