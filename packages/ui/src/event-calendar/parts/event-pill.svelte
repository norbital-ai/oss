<script lang="ts">
	import { cn } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import type { CalendarEvent } from '#lib/event-calendar/types';

	let {
		event,
		onclick,
		class: className
	}: {
		event: CalendarEvent;
		onclick?: (e: CalendarEvent) => void;
		class?: string;
	} = $props();

	const accentColor = $derived(event.color ?? 'var(--color-brand)');
</script>

<button
	class={cn(
		'px-1.5 py-0.5 rounded-full text-tiny font-semibold leading-none truncate max-w-full',
		'transition-colors hover:brightness-95 bg-muted/60',
		className
	)}
	onclick={() => onclick?.(event)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onclick?.(event);
		}
	}}
>
	<Inline as="span" gap="xs">
		<span class="size-[5px] rounded-full shrink-0" style="background: {accentColor}"></span>
		<span class="truncate text-foreground">{event.title}</span>
	</Inline>
</button>
