<script lang="ts">
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import type { RendererProps, Value } from './$types.js';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { shiftBreaksSchema } from './+definition.js';
	import type { z } from 'zod/mini';

	type ShiftBreaks = z.infer<typeof shiftBreaksSchema>;

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
	const mode = $derived(props.mode);
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsedIncoming = $derived(shiftBreaksSchema.safeParse(props.value));
	const incoming = $derived(parsedIncoming.success ? parsedIncoming.data : []);
	let edits = $state<ShiftBreaks | null>(null);
	const breaks = $derived(edits ?? incoming);
	function onValueChange(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}
	const locked = $derived(Boolean(disabled || mode === 'display'));
	const rows = $derived(
		breaks.map((entry, index): BreakRow => ({
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
	bounded={false}
	onChange={(nextRows) => {
		const nextValue = nextRows.map(({ start, end, paid }) => ({ start, end, paid }));
		edits = nextValue;
		onValueChange(nextValue);
	}}
/>
