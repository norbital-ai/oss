<script lang="ts">
	import { Calendar as CalendarPrimitive } from 'bits-ui';

	let { ref = $bindable(null), ...restProps }: CalendarPrimitive.GridHeadProps = $props();
</script>

<CalendarPrimitive.GridHead bind:ref {...restProps} />
