<script lang="ts">
	import { cn } from '#lib/utils';
	import { RangeCalendar as RangeCalendarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: RangeCalendarPrimitive.GridProps = $props();
</script>

<RangeCalendarPrimitive.Grid
	bind:ref
	class={cn('w-full border-collapse', className)}
	{...restProps}
/>
