<script lang="ts">
	import { nullableNumberFrom } from '../../lib/ui/renderer-input.js';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { statutoryFactStatusSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type StatusKind = Value['kind'];

	const KIND_OPTIONS: { value: StatusKind; label: string; description: string }[] = [
		{
			value: 'REGISTERED',
			label: 'Registered',
			description: 'Has a reference number with the authority'
		},
		{
			value: 'NOT_REGISTERED',
			label: 'Not registered',
			description: 'Exempt or out of scope — a reason is required'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(statutoryFactStatusSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.kind === 'NOT_REGISTERED') return `Not registered — ${current.reason}`;
		const override = current.rate_override === null ? '' : ` @ ${current.rate_override}`;
		return `Registered ${current.reference_number}${override}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: StatusKind): Value {
		switch (kind) {
			case 'REGISTERED':
				return { kind: 'REGISTERED', reference_number: '', rate_override: null };
			case 'NOT_REGISTERED':
				return { kind: 'NOT_REGISTERED', reason: '' };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: StatusKind | null): void {
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
			Status
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a status"
				onValueChange={selectKind}
			/>
		</label>
		{#if current?.kind === 'REGISTERED'}
			<label class="grid gap-1.5 text-sm font-medium">
				Reference number
				<Input
					value={current.reference_number}
					{disabled}
					placeholder="Authority reference"
					oninput={(event) => emit({ ...current, reference_number: event.currentTarget.value })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Rate override (blank = use the band)
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.rate_override ?? ''}
					{disabled}
					oninput={(event) =>
						emit({ ...current, rate_override: nullableNumberFrom(event.currentTarget.value) })}
				/>
			</label>
		{:else if current?.kind === 'NOT_REGISTERED'}
			<label class="grid gap-1.5 text-sm font-medium">
				Reason
				<Input
					value={current.reason}
					{disabled}
					placeholder="Why this employment is out of scope"
					oninput={(event) => emit({ kind: 'NOT_REGISTERED', reason: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
