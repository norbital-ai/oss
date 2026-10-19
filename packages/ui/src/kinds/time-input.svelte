<!-- @component Edits dates, instants or clocks, singly or as an array. -->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import type { DateInputProps } from './date-input.svelte';
	/** A date, instant or clock value as text, an empty value, or an ordered array of those values. */
	export type TimeValue = string | null | readonly (string | null)[];
	type Common = Omit<DateInputProps, 'value' | 'onChange' | 'of'> & {
		of?: 'date' | 'instant' | 'time';
	};
	/** Date/instant/time editor options with a value and change callback of matching scalar or array shape; array mode offers adding and removing entries. */
	export type TimeInputProps<V extends TimeValue = TimeValue> = Common &
		(V extends readonly (string | null)[]
			? { value: readonly (string | null)[]; onChange(next: readonly (string | null)[]): void }
			: { value: string | null; onChange(next: string | null): void });
	const many = (props: TimeInputProps): props is TimeInputProps<readonly (string | null)[]> =>
		Arr.isArray(props.value);
</script>

<script lang="ts">
	import DateInput from './date-input.svelte';
	import Button from '../primitives/button/button.svelte';
	import { useControls, uiText } from '../primitives/utils.js';
	let props: TimeInputProps = $props();
	const controls = useControls();
	const t = uiText();
	const readonly = $derived(props.readonly ?? controls.readonly);
	const disabled = $derived(props.disabled ?? controls.disabled);
	const array = $derived(many(props) ? props : null);
	const scalar = $derived(many(props) ? null : props);
</script>

{#if array !== null}
	<div class="grid gap-2" data-time-values>
		{#each array.value as item, i (i)}
			<div class="flex min-w-0 items-center gap-2">
				<DateInput
					{...props}
					id={props.id ? `${props.id}-${i}` : undefined}
					value={item}
					onChange={(next) =>
						array?.onChange(array.value.map((value, index) => (index === i ? next : value)))}
				/>
				{#if !readonly}<Button
						variant="ghost"
						{disabled}
						onclick={() => array?.onChange(array.value.filter((_, index) => index !== i))}
						>{t('remove')}</Button
					>{/if}
			</div>
		{/each}
		{#if !readonly}<Button
				class="w-fit"
				size="sm"
				variant="outline"
				{disabled}
				onclick={() => array?.onChange([...array.value, null])}>{t('add')}</Button
			>{/if}
	</div>
{:else if scalar !== null}
	<DateInput {...props} value={scalar.value} onChange={(next) => scalar?.onChange(next)} />
{/if}
