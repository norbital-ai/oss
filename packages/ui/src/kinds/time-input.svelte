<!-- @component Edits dates, instants or clocks, singly or as an array. -->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import type { DateInputProps } from './date-input.svelte';
	/** A date, instant or clock value as text, an empty value, or an ordered array of those values. */
	export type TimeValue = string | null | readonly (string | null)[];
	type Common = Omit<DateInputProps, 'value' | 'on_change' | 'of'> & {
		of?: 'date' | 'instant' | 'time';
	};
	/** Date/instant/time editor options with a value and change callback of matching scalar or array shape; array mode offers adding and removing entries. */
	export type TimeInputProps<V extends TimeValue = TimeValue> = Common &
		(V extends readonly (string | null)[]
			? { value: readonly (string | null)[]; on_change(next: readonly (string | null)[]): void }
			: { value: string | null; on_change(next: string | null): void });
	const many = (props: TimeInputProps): props is TimeInputProps<readonly (string | null)[]> =>
		Arr.isArray(props.value);
</script>

<script lang="ts">
	import DateInput from './date-input.svelte';
	import TimeList from './time-list.svelte';
	let props: TimeInputProps = $props();
	const array = $derived(many(props) ? props : null);
	const scalar = $derived(many(props) ? null : props);
</script>

{#if array !== null}
	<TimeList
		values={array.value}
		on_change={(next) => array?.on_change(next)}
		empty={null}
		id={props.id}
		readonly={props.readonly}
		disabled={props.disabled}
	>
		{#snippet item(value, change, id)}
			<DateInput {...props} {id} {value} on_change={change} />
		{/snippet}
	</TimeList>
{:else if scalar !== null}
	<DateInput {...props} value={scalar.value} on_change={(next) => scalar?.on_change(next)} />
{/if}
