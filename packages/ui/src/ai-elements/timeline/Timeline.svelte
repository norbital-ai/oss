<script lang="ts">
	import { Collapsible } from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { TimelineContext, setTimelineContext } from './timeline-context.svelte.js';

	interface TimelineProps extends HTMLAttributes<HTMLDivElement> {
		/**
		 * Whether the timeline is open (controlled)
		 */
		open?: boolean;
		/**
		 * Default open state (uncontrolled)
		 */
		defaultOpen?: boolean;
		/**
		 * Callback when open state changes
		 */
		onOpenChange?: (open: boolean) => void;
		/**
		 * Children content
		 */
		children: Snippet;
		/**
		 * Additional CSS classes
		 */
		class?: string;
	}

	let {
		open = $bindable(undefined),
		defaultOpen = false,
		onOpenChange,
		children,
		class: className,
		...restProps
	}: TimelineProps = $props();

	// Create context instance with proper controllable state
	const context = new TimelineContext(
		untrack(() => ({
			isOpen: open !== undefined ? open : defaultOpen,
			onOpenChange
		}))
	);

	watch(
		() => open,
		(nextOpen) => {
			if (nextOpen === undefined) return;
			context.isOpen = nextOpen;
		}
	);

	// Set the context for child components
	setTimelineContext(() => context);
</script>

<Collapsible open={context.isOpen} onOpenChange={context.setIsOpen}>
	<div class={cn('not-prose max-w-none', className)} {...restProps}>
		{@render children()}
	</div>
</Collapsible>
