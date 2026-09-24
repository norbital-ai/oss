<script lang="ts">
	import { cn } from '#lib/utils';
	import { Imposter, Inline } from '#lib/layout';
	import type { CalendarEvent, EventRenderContext } from '#lib/event-calendar/types';
	import type { Snippet } from 'svelte';

	let {
		event,
		onclick,
		eventContent,
		class: className,
		style = ''
	}: {
		event: CalendarEvent;
		onclick?: (e: CalendarEvent) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		class?: string;
		style?: string;
	} = $props();

	const color = $derived(event.color ?? 'var(--color-brand)');
	const ctx: EventRenderContext = {
		view: 'week' as const,
		mode: 'bar',
		isMultiDay: true,
		column: 0,
		lane: 0,
		totalLanes: 1
	};
</script>

<!-- An all-day bar at its computed lane offset inside the lane band. -->
<Imposter
	as="button"
	placement="top-start"
	offset="none"
	layer="under"
	class={cn('h-5 rounded-full bg-muted/60 px-2 py-0 text-left transition-colors', className)}
	{style}
	onclick={() => onclick?.(event)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onclick?.(event);
		}
	}}
>
	<Inline as="span" gap="xs">
		<span class="size-[5px] rounded-full shrink-0" style="background: {color}"></span>
		{#if eventContent}
			{@render eventContent(event, ctx)}
		{:else}
			<span class="text-tiny font-semibold truncate text-foreground">
				{event.title}
			</span>
		{/if}
	</Inline>
</Imposter>
