<!--
@component
Edits date, instant or clock ranges, singly or as an array, at the requested precision.
-->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import { valueObject, type Value } from './kind.js';
	import type { PeriodInputProps } from './period-input.svelte';
	/** The datatype, precision and controlled scalar or array ranges of TimeRangeInput. */
	export type TimeRangeInputProps = Omit<PeriodInputProps, 'of' | 'value' | 'onChange'> & {
		of: 'date' | 'instant' | 'time';
		value: Value;
		onChange(next: Value): void;
		'aria-label'?: string;
	};
</script>

<script lang="ts">
	import PeriodInput from './period-input.svelte';
	import TimeOfDayRangeInput from './time-of-day-range-input.svelte';
	import Button from '../primitives/button/button.svelte';
	import { useControls, uiText } from '../primitives/utils.js';
	let { value, onChange, of, ...props }: TimeRangeInputProps = $props();
	const controls = useControls();
	const t = uiText();
	const readonly = $derived(props.readonly ?? controls.readonly);
	const disabled = $derived(props.disabled ?? controls.disabled);
	const list = $derived(Arr.isArray<Value>(value) ? value : null);
	const clock = (v: Value) => {
		const r = valueObject(v) ? v : {};
		return {
			start: typeof r.start === 'string' ? r.start : null,
			end: typeof r.end === 'string' ? r.end : null
		};
	};
</script>

{#snippet single(item: Value, change: (next: Value) => void, id: string | undefined)}
	{#if of === 'time'}<TimeOfDayRangeInput
			{...props}
			{id}
			precision={props.precision === 'hour' ? 'hour' : 'minute'}
			value={clock(item)}
			onChange={change}
		/>{:else}<PeriodInput {...props} {id} {of} value={item} onChange={change} />{/if}
{/snippet}
{#if list !== null}<div class="grid gap-2" data-time-ranges>
		{#each list as item, i (i)}<div class="flex min-w-0 items-center gap-2">
				{@render single(
					item,
					(next) => onChange(list.map((v, n) => (n === i ? next : v))),
					props.id ? `${props.id}-${i}` : undefined
				)}{#if !readonly}<Button
						variant="ghost"
						{disabled}
						onclick={() => onChange(list.filter((_, n) => n !== i))}>{t('remove')}</Button
					>{/if}
			</div>{/each}
		{#if !readonly}<Button
				class="w-fit"
				size="sm"
				variant="outline"
				{disabled}
				onclick={() => onChange([...list, null])}>{t('add')}</Button
			>{/if}
	</div>{:else}{@render single(value, (next) => onChange(next), props.id)}{/if}
