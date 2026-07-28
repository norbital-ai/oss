<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CalendarEvent, EventRenderContext } from '../types.js';
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

<button
	class={cn(
		'absolute h-[20px] rounded-full text-left px-2 py-0 flex items-center gap-1.5',
		'transition-colors bg-muted/60',
		className
	)}
	{style}
	onclick={() => onclick?.(event)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onclick?.(event);
		}
	}}
>
	<span class="size-[5px] rounded-full shrink-0" style="background: {color}"></span>
	{#if eventContent}
		{@render eventContent(event, ctx)}
	{:else}
		<span class="text-tiny font-semibold truncate text-foreground">
			{event.title}
		</span>
	{/if}
</button>
