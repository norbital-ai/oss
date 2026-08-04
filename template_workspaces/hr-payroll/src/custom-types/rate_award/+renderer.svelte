<script lang="ts">
	import { numberFrom } from '../../lib/ui/renderer-input.js';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { rateAwardSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type AwardKind = Value['kind'];

	const KIND_OPTIONS: { value: AwardKind; label: string; description: string }[] = [
		{ value: 'PERCENT', label: 'Percent of base', description: 'Employee / employer percentages' },
		{ value: 'FIXED', label: 'Fixed amount', description: 'Flat amount per side' },
		{
			value: 'PROGRESSIVE',
			label: 'Progressive',
			description: 'rate × base + constant (constant may be negative)'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(rateAwardSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.kind === 'PROGRESSIVE') return `${current.rate} × base + ${current.constant}`;
		const suffix = current.kind === 'PERCENT' ? '%' : '';
		return `EE ${current.employee}${suffix} / ER ${current.employer}${suffix}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: AwardKind): Value {
		switch (kind) {
			case 'PERCENT':
				return { kind: 'PERCENT', employee: 0, employer: 0 };
			case 'FIXED':
				return { kind: 'FIXED', employee: 0, employer: 0 };
			case 'PROGRESSIVE':
				return { kind: 'PROGRESSIVE', rate: 0, constant: 0 };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: AwardKind | null): void {
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
			Award
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an award"
				onValueChange={selectKind}
			/>
		</label>

		{#if current?.kind === 'PROGRESSIVE'}
			<label class="grid gap-1.5 text-sm font-medium">
				Rate
				<Input
					type="number"
					min="0"
					step="0.0001"
					value={current.rate}
					{disabled}
					oninput={(event) => emit({ ...current, rate: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Constant (may be negative)
				<Input
					type="number"
					step="0.01"
					value={current.constant}
					{disabled}
					oninput={(event) =>
						emit({ ...current, constant: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
		{:else if current !== null}
			<label class="grid gap-1.5 text-sm font-medium">
				Employee {current.kind === 'PERCENT' ? '(%)' : '(amount)'}
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.employee}
					{disabled}
					oninput={(event) =>
						emit({ ...current, employee: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Employer {current.kind === 'PERCENT' ? '(%)' : '(amount)'}
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.employer}
					{disabled}
					oninput={(event) =>
						emit({ ...current, employer: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
