<script lang="ts">
	import { cn } from '#lib/utils';
	import { eventTimeLabel } from '#lib/event-calendar/utils';
	import type { CalendarEvent, EventRenderContext } from '#lib/event-calendar/types';
	import type { Snippet } from 'svelte';

	let {
		event,
		ctx,
		onclick,
		eventContent,
		class: className,
		style = ''
	}: {
		event: CalendarEvent;
		ctx: EventRenderContext;
		onclick?: (e: CalendarEvent) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		class?: string;
		style?: string;
	} = $props();

	const accentColor = $derived(event.color ?? 'var(--color-brand)');
</script>

<button
	class={cn(
		'absolute left-px right-px rounded-md border text-left overflow-hidden',
		'bg-card shadow-xs hover:shadow-sm transition-shadow',
		'cursor-grab active:cursor-grabbing',
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
	<div class="h-[3px] w-full" style="background: {accentColor}"></div>
	<div class="px-1.5 py-1 min-w-0">
		{#if eventContent}
			{@render eventContent(event, ctx)}
		{:else}
			<p class="text-micro font-semibold text-foreground leading-tight truncate">
				{event.title}
			</p>
			{#if ctx.mode !== 'pill'}
				<p class="text-tiny text-muted-foreground mt-0.5 font-mono tabular-nums truncate">
					{eventTimeLabel(event)}
				</p>
			{/if}
		{/if}
	</div>
</button>
