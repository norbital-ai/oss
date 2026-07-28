<script lang="ts">
	import Icon from '@iconify/svelte';
	import { CollapsibleTrigger } from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { Shimmer } from '../shimmer';
	import { getTimelineContext } from './timeline-context.svelte.js';

	interface TimelineHeaderProps {
		/**
		 * Children content (optional, defaults to "Timeline")
		 */
		children?: Snippet;
		/**
		 * When true, label text uses a shimmer effect.
		 */
		isActive?: boolean;
		/**
		 * Iconify icon id for the step header.
		 */
		icon?: string;
		/**
		 * Additional CSS classes
		 */
		class?: string;
	}

	let {
		children,
		isActive = false,
		icon = 'lucide:brain',
		class: className
	}: TimelineHeaderProps = $props();

	const context = getTimelineContext()();
	const labelLength = $derived(isActive ? 12 : 8);
</script>

<CollapsibleTrigger
	class={cn(
		'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-micro font-medium text-foreground transition-colors hover:bg-muted/20',
		className
	)}
>
	<Icon
		{icon}
		class={cn('size-3.5 shrink-0', isActive ? 'text-foreground' : 'text-muted-foreground/80')}
	/>
	<span class="min-w-0 flex-1 text-left">
		{#if isActive}
			<Shimmer class="text-micro font-medium" content_length={labelLength}>
				{#if children}
					{@render children()}
				{:else}
					Timeline
				{/if}
			</Shimmer>
		{:else if children}
			{@render children()}
		{:else}
			Timeline
		{/if}
	</span>
	<Icon
		icon="lucide:chevron-down"
		class={cn(
			'size-2.5 shrink-0 text-foreground/45 transition-transform duration-150',
			context.isOpen ? 'rotate-180' : 'rotate-0'
		)}
	/>
</CollapsibleTrigger>
