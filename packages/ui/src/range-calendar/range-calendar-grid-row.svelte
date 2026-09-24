<script lang="ts">
	import { cn } from '#lib/utils';
	import { RangeCalendar as RangeCalendarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: RangeCalendarPrimitive.GridRowProps = $props();
</script>

<!-- repository-health:allow UI6 -- bits-ui renders this row as a <tr>; a primitive's `as` list has no table row, so its `child` snippet cannot hand it to an Inline -->
<RangeCalendarPrimitive.GridRow bind:ref class={cn('flex', className)} {...restProps} />
