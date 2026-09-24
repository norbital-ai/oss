<script lang="ts">
	import { Imposter } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { generateTimeSlots } from '#lib/event-calendar/utils';

	let {
		startHour = 0,
		endHour = 24,
		stepMinutes = 60,
		hourHeight = 60,
		compact = false,
		class: className
	}: {
		startHour?: number;
		endHour?: number;
		stepMinutes?: number;
		hourHeight?: number;
		compact?: boolean;
		class?: string;
	} = $props();

	const slots = $derived(generateTimeSlots(startHour, endHour, stepMinutes));
</script>

<!-- The hour axis stays pinned while the time grid scrolls sideways. -->
<Imposter
	position="sticky"
	placement="start"
	class={cn('inset-y-auto bg-card select-none', compact ? 'w-10' : 'w-15', className)}
>
	{#each slots as slot}
		<div
			style="height: {(stepMinutes / 60) * hourHeight}px"
			class={cn(
				'pr-2 text-right text-tiny font-mono tabular-nums text-muted-foreground',
				slots.indexOf(slot) % (60 / stepMinutes) === 0 ? '-mt-[0.5em] leading-none' : 'text-tiny'
			)}
		>
			{slot}
		</div>
	{/each}
</Imposter>
