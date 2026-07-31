<script lang="ts">
	import { cn } from '#lib/utils';
	import { onMount } from 'svelte';
	import { dateToPixels, formatTimeLabel, isSameDay } from '../utils.js';

	let {
		date,
		hourHeight = 60,
		startHour = 0,
		endHour = 24,
		timeAxisWidth = 60,
		class: className
	}: {
		date: Date;
		hourHeight?: number;
		startHour?: number;
		endHour?: number;
		timeAxisWidth?: number;
		class?: string;
	} = $props();

	let now = $state(new Date());

	onMount(() => {
		const interval = setInterval(() => {
			now = new Date();
		}, 60_000);
		return () => clearInterval(interval);
	});

	const top = $derived(dateToPixels(now, date, hourHeight, startHour));

	const isToday = $derived(isSameDay(now, date));

	const timeLabel = $derived(formatTimeLabel(now));
</script>

{#if isToday && top >= 0 && top <= (endHour - startHour) * hourHeight}
	<div
		class={cn('absolute left-0 right-0 z-10 pointer-events-none', className)}
		style="top: {timeAxisWidth > 0 ? `calc(${top}px + 0)` : `${top}px`}"
	>
		<!-- stupidity:allow UI6 -- now-pill over the time axis is absolutely-positioned decoration -->
		<div class="absolute left-0 -top-[0.6em] flex items-center gap-1">
			<div class="size-2 rounded-full bg-brand"></div>
			<span class="text-tiny font-medium text-brand font-mono tabular-nums">
				{timeLabel}
			</span>
		</div>
		<div class="absolute left-0 right-0 h-px bg-brand"></div>
	</div>
{/if}
