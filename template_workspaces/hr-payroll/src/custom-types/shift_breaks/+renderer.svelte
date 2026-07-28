<script lang="ts">
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import type { RendererProps, Value } from './$types.js';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { watch } from 'runed';
	import { shiftBreaksSchema } from './+definition.js';

	interface BreakRow {
		id: string;
		start: string;
		end: string;
		paid: boolean;
	}

	const breakColumns = [
		{
			key: 'start',
			label: 'Start',
			field: { name: 'start', kind: 'clock_time', nullable: false } satisfies CollectionField,
			width: 160
		},
		{
			key: 'end',
			label: 'End',
			field: { name: 'end', kind: 'clock_time', nullable: false } satisfies CollectionField,
			width: 160
		},
		{
			key: 'paid',
			label: 'Paid',
			field: { name: 'paid', kind: 'boolean', nullable: false } satisfies CollectionField,
			width: 120
		}
	] satisfies readonly MatrixColumn<BreakRow>[];

	let props: RendererProps = $props();
	const value = $derived(props.value);
	const mode = $derived(props.mode);
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	function onValueChange(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}
	// svelte-ignore state_referenced_locally -- subsequent external form changes are synchronized below.
	const initialBreaks = shiftBreaksSchema.safeParse(value);
	let draftBreaks = $state(initialBreaks.success ? initialBreaks.data : []);
	watch(
		() => value,
		(nextValue) => {
			const parsed = shiftBreaksSchema.safeParse(nextValue);
			if (parsed.success) draftBreaks = parsed.data;
		},
		{ lazy: true }
	);
	const locked = $derived(Boolean(disabled || mode === 'display'));
	const rows = $derived(
		draftBreaks.map((entry, index): BreakRow => ({
			id: `${entry.start}:${entry.end}:${index}`,
			start: entry.start,
			end: entry.end,
			paid: entry.paid
		}))
	);
</script>

<MatrixRenderer
	{rows}
	columns={breakColumns}
	disabled={locked}
	emptyMessage="No scheduled breaks."
	createRow={(): BreakRow => ({
		id: crypto.randomUUID(),
		start: '12:00',
		end: '13:00',
		paid: false
	})}
	addRowLabel="Add break"
	onChange={(nextRows) => {
		const nextValue = nextRows.map(({ start, end, paid }) => ({ start, end, paid }));
		draftBreaks = nextValue;
		onValueChange?.(nextValue);
	}}
/>
