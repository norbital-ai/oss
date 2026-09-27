<!--
@component
Picks a month (`YYYY-MM`) from a month grid, between `min` and `max`.
-->
<script lang="ts" module>
	/** The props of `MonthInput`. */
	export type MonthInputProps = { value: string | null; onChange(next: string | null): void; id?: string; disabled?: boolean; min?: string; max?: string };
</script>

<script lang="ts">
	import DateInput from './date-input.svelte';

	let props: MonthInputProps = $props();
</script>

<DateInput {...props} of="month" />
