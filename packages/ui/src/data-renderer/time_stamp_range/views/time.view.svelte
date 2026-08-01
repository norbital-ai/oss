<script lang="ts">
	import type { Time } from '@internationalized/date';
	import { TimeField } from '#lib/time-field';
	import { TimeRangeField, type TimeRange } from '#lib/time-range';
	import { cn } from '#lib/utils';

	let {
		isSameDay,
		hasEnd,
		value,
		granularity,
		hourCycle,
		disabled,
		onStartChange,
		onEndChange,
		onRangeChange,
		class: className
	}: {
		isSameDay: boolean;
		hasEnd: boolean;
		value: TimeRange<Time>;
		granularity: 'minute' | 'second';
		hourCycle: 12 | 24;
		disabled: boolean;
		onStartChange: (time: Time | undefined) => void;
		onEndChange: (time: Time | undefined) => void;
		onRangeChange: (range: TimeRange<Time> | undefined) => void;
		class?: string;
	} = $props();
</script>

{#if isSameDay && hasEnd}
	<TimeRangeField
		label="Time Range"
		{value}
		onValueChange={onRangeChange}
		{granularity}
		{hourCycle}
		{disabled}
		class={cn('w-full', className)}
		inputClass="h-8 text-xs border-border focus-within:border-brand focus-within:ring-1 focus-within:ring-brand"
		labelClass="text-xs font-medium text-secondary-foreground"
		segmentClass="text-xs hover:bg-muted focus:bg-brand-100 focus:text-brand-900"
		separatorClass="text-muted-foreground"
	/>
{:else}
	<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
	<div class={cn('grid gap-4', hasEnd ? 'grid-cols-2' : 'grid-cols-1', className)}>
		<TimeField
			label="Start Time"
			value={value.start}
			onValueChange={onStartChange}
			{granularity}
			{hourCycle}
			{disabled}
			class="w-full"
			inputClass="h-8 text-xs border-border focus-within:border-brand focus-within:ring-1 focus-within:ring-brand"
			labelClass="text-xs font-medium text-secondary-foreground"
			segmentClass="text-xs hover:bg-muted focus:bg-brand-100 focus:text-brand-900"
		/>
		{#if hasEnd}
			<TimeField
				label="End Time"
				value={value.end}
				onValueChange={onEndChange}
				{granularity}
				{hourCycle}
				{disabled}
				class="w-full"
				inputClass="h-8 text-xs border-border focus-within:border-brand focus-within:ring-1 focus-within:ring-brand"
				labelClass="text-xs font-medium text-secondary-foreground"
				segmentClass="text-xs hover:bg-muted focus:bg-brand-100 focus:text-brand-900"
			/>
		{/if}
	</div>
{/if}
