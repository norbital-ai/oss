<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { payslipLineSourceSchema, type PayslipLineSource } from './+definition.js';
	import type { RendererProps } from './$types.js';

	type Kind = PayslipLineSource['kind'];

	const KIND_OPTIONS: { value: Kind; label: string; description: string }[] = [
		{
			value: 'COMPONENT_ENTRY',
			label: 'Component entry',
			description: 'An amount entered on the entry stream'
		},
		{
			value: 'TIME_ENTRY',
			label: 'Time entry',
			description: 'A clocked attendance record the line was computed from'
		},
		{
			value: 'LEAVE_REQUEST',
			label: 'Leave request',
			description: 'A leave request the line was computed from'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(payslipLineSourceSchema.safeParse(props.value));
	const current = $derived<PayslipLineSource | null>(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		switch (current.kind) {
			case 'COMPONENT_ENTRY':
				return `Component entry · ${current.entry_id}`;
			case 'TIME_ENTRY':
				return `Time entry · ${current.time_entry_id}`;
			case 'LEAVE_REQUEST':
				return `Leave request · ${current.leave_request_id}`;
		}
	});

	function emit(next: PayslipLineSource | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: Kind): PayslipLineSource {
		switch (kind) {
			case 'COMPONENT_ENTRY':
				return { kind: 'COMPONENT_ENTRY', entry_id: '' };
			case 'TIME_ENTRY':
				return { kind: 'TIME_ENTRY', time_entry_id: '' };
			case 'LEAVE_REQUEST':
				return { kind: 'LEAVE_REQUEST', leave_request_id: '' };
		}
	}

	function selectKind(kind: Kind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Source
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a source"
				onValueChange={selectKind}
			/>
		</label>

		{#if current?.kind === 'COMPONENT_ENTRY'}
			<label class="grid gap-1.5 text-sm font-medium">
				Component entry id
				<Input
					value={current.entry_id}
					{disabled}
					placeholder="UUID of the component entry"
					oninput={(event) =>
						emit({ kind: 'COMPONENT_ENTRY', entry_id: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.kind === 'TIME_ENTRY'}
			<label class="grid gap-1.5 text-sm font-medium">
				Time entry id
				<Input
					value={current.time_entry_id}
					{disabled}
					placeholder="UUID of the time entry"
					oninput={(event) =>
						emit({ kind: 'TIME_ENTRY', time_entry_id: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.kind === 'LEAVE_REQUEST'}
			<label class="grid gap-1.5 text-sm font-medium">
				Leave request id
				<Input
					value={current.leave_request_id}
					{disabled}
					placeholder="UUID of the leave request"
					oninput={(event) =>
						emit({ kind: 'LEAVE_REQUEST', leave_request_id: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
