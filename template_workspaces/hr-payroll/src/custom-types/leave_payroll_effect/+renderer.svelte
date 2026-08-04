<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { leavePayrollEffectSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type EffectKind = Value['kind'];

	const KIND_OPTIONS: { value: EffectKind; label: string; description: string }[] = [
		{ value: 'PAID', label: 'Paid', description: 'No effect on pay' },
		{
			value: 'UNPAID',
			label: 'Unpaid',
			description: 'Deducted through a named pay component'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(leavePayrollEffectSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.kind === 'PAID' ? 'Paid' : `Unpaid · ${current.component_id}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: EffectKind): Value {
		switch (kind) {
			case 'PAID':
				return { kind: 'PAID' };
			case 'UNPAID':
				return { kind: 'UNPAID', component_id: '' };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: EffectKind | null): void {
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
			Payroll effect
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an effect"
				onValueChange={selectKind}
			/>
		</label>
		{#if current?.kind === 'UNPAID'}
			<label class="grid gap-1.5 text-sm font-medium">
				Deduction component id
				<Input
					value={current.component_id}
					{disabled}
					placeholder="UUID of the unpaid-leave pay component"
					oninput={(event) => emit({ kind: 'UNPAID', component_id: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
