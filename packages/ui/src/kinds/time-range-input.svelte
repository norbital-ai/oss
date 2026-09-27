<!--
@component
Two times of day (`HH:MM`) in one field; an end before the start runs overnight.
-->
<script lang="ts" module>
	/** Two times of day (`HH:MM`) in one field, typed by segment; an end before the start is overnight, never refused. */
	export type TimeRange = { start: string | null; end: string | null };
	/** The props of `TimeRangeInput`. */
	export type TimeRangeInputProps = {
		value: TimeRange;
		onChange(next: TimeRange): void;
		id?: string;
		/** Shows the value as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		class?: string;
		'aria-label'?: string;
	};
</script>

<script lang="ts">
	import type { Time } from '@internationalized/date';
	import { TimeRangeField } from 'bits-ui';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import { cn, uiText, useControls } from '../primitives/utils.js';
	import { SEGMENT, SEGMENTS } from './classes.js';
	import { useKinds } from './context.js';
	import { timeValue } from './date-input.svelte';

	let { value, onChange, id, readonly, disabled: ownDisabled, invalid = false, class: className, 'aria-label': ariaLabel }: TimeRangeInputProps = $props();
	const controls = useControls();
	const t = uiText();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const locale = useKinds().locale;
	const hhmm = (t: Time | undefined) => (t === undefined ? null : t.toString().slice(0, 5));
</script>

{#if readonly ?? controls.readonly}
	{@const text = value.start === null && value.end === null ? '' : `${value.start ?? '…'} – ${value.end ?? '…'}`}
	<CopyText {id} {text} class="tabular-nums">{#if text === ''}<span class="text-muted-foreground">{t('none')}</span>{:else}{text}{/if}</CopyText>
{:else}
<TimeRangeField.Root
	value={{ start: timeValue(value.start), end: timeValue(value.end) }}
	onValueChange={(r) => onChange({ start: hhmm(r?.start as Time | undefined), end: hhmm(r?.end as Time | undefined) })}
	{disabled}
	{locale}
	hourCycle={24}
	granularity="minute"
>
	<div {id} class={cn(SEGMENTS, 'w-auto', invalid && 'border-destructive', className)} role="group" aria-label={ariaLabel} data-time-range>
		{#each ['start', 'end'] as const as type (type)}
			<TimeRangeField.Input {type}>
				{#snippet children({ segments })}
					{#each segments as { part, value: text }, i (i)}<TimeRangeField.Segment {part} class={SEGMENT}>{text}</TimeRangeField.Segment>{/each}
				{/snippet}
			</TimeRangeField.Input>
			{#if type === 'start'}<span class="px-2 text-muted-foreground" aria-hidden="true">→</span>{/if}
		{/each}
	</div>
</TimeRangeField.Root>
{/if}
