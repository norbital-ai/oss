<script lang="ts">
	import { cn } from '#lib/utils';
	import { generateTimeSlots } from '../utils.js';

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

<div class={cn('sticky left-0 z-10 bg-card select-none', compact ? 'w-10' : 'w-[60px]', className)}>
	{#each slots as slot}
		<div
			style="height: {(stepMinutes / 60) * hourHeight}px"
			class={cn(
				'flex items-start justify-end pr-2 text-tiny font-mono tabular-nums text-muted-foreground',
				slots.indexOf(slot) % (60 / stepMinutes) === 0 ? '-mt-[0.5em] leading-none' : 'text-tiny'
			)}
		>
			{slot}
		</div>
	{/each}
</div>
