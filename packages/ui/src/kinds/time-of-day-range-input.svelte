<!--
@component
Two times of day (`HH:MM`) in one field; an end before the start runs overnight.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	/** Two times of day (`HH:MM`) in one field, typed by segment; an end before the start is overnight, never refused. */
	type TimeRange = { start: string | null; end: string | null };
	/** The props of `TimeOfDayRangeInput`. */
	export type TimeOfDayRangeInputProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		precision?: 'hour' | 'minute';
		value: TimeRange;
		on_change(next: TimeRange): void;
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
	import { create_time_field } from '../behaviors/index.js';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import { cn, ui_text, use_controls } from '../primitives/utils.js';
	import { SEGMENT, SEGMENTS } from './classes.js';
	import { timeValue } from './date-input.svelte';

	let {
		ctx: _ctx,
		value,
		on_change,
		precision = 'minute',
		id,
		readonly,
		disabled: ownDisabled,
		invalid = false,
		class: className,
		'aria-label': ariaLabel
	}: TimeOfDayRangeInputProps = $props();
	const controls = use_controls();
	const t = ui_text();
	const disabled = $derived(ownDisabled ?? controls.disabled);
	const hhmm = (t: Time | undefined) =>
		t === undefined
			? null
			: precision === 'hour'
				? t.toString().slice(0, 2) + ':00'
				: t.toString().slice(0, 5);

	const startField = create_time_field({
		value: () => timeValue(value.start),
		granularity: () => precision,
		disabled: () => disabled,
		on_change: (start) => on_change({ start: hhmm(start), end: value.end })
	});

	const endField = create_time_field({
		value: () => timeValue(value.end),
		granularity: () => precision,
		disabled: () => disabled,
		on_change: (end) => on_change({ start: value.start, end: hhmm(end) })
	});
</script>

{#if readonly ?? controls.readonly}
	{@const text =
		value.start === null && value.end === null ? '' : `${value.start ?? '…'} – ${value.end ?? '…'}`}
	<CopyText {id} {text} class="tabular-nums"
		>{#if text === ''}<span class="text-muted-foreground">{t('none')}</span
			>{:else}{text}{/if}</CopyText
	>
{:else}
	<div
		{id}
		class={cn(SEGMENTS, 'w-auto', invalid && 'border-destructive', className)}
		role="group"
		aria-label={ariaLabel}
		data-time-range
	>
		<span class="inline-flex items-center">
			{#each startField.segments as seg, i (i)}
				<span
					{@attach startField.segment_ref(seg.part)}
					{...startField.segment_attrs(seg)}
					class={SEGMENT}>{seg.value}</span
				>
			{/each}
		</span>
		<span class="px-2 text-muted-foreground" aria-hidden="true">→</span>
		<span class="inline-flex items-center">
			{#each endField.segments as seg, i (i)}
				<span
					{@attach endField.segment_ref(seg.part)}
					{...endField.segment_attrs(seg)}
					class={SEGMENT}>{seg.value}</span
				>
			{/each}
		</span>
	</div>
{/if}
