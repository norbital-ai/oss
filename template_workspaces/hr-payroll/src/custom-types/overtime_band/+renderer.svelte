<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { overtimeBandSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type Measure = Value['measure'];

	const MEASURE_OPTIONS: { value: Measure; label: string; description: string }[] = [
		{
			value: 'BEYOND_NORMAL',
			label: 'Beyond normal hours',
			description: 'Hours worked past the normal daily hours'
		},
		{
			value: 'FROM_START_OF_DAY',
			label: 'From start of day',
			description: 'Fractions of a normal day, counted from the first minute'
		}
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(overtimeBandSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.measure === 'BEYOND_NORMAL'
			? `Beyond normal ${current.from_hours}h – ${current.to_hours ?? '∞'}h`
			: `From start of day ${current.from_fraction} – ${current.to_fraction ?? '∞'} day`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(measure: Measure): Value {
		switch (measure) {
			case 'BEYOND_NORMAL':
				return { measure: 'BEYOND_NORMAL', from_hours: 0, to_hours: null };
			case 'FROM_START_OF_DAY':
				return { measure: 'FROM_START_OF_DAY', from_fraction: 0, to_fraction: null };
		}
	}

	function selectMeasure(measure: Measure | null): void {
		if (measure === null) {
			emit(null);
			return;
		}
		if (current !== null && current.measure === measure) return;
		emit(defaultFor(measure));
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}

	function nullableNumberFrom(raw: string): number | null {
		if (raw.trim().length === 0) return null;
		const next = Number(raw);
		return Number.isFinite(next) ? next : null;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Measure
			<Combobox
				options={MEASURE_OPTIONS}
				value={current?.measure ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a measure"
				onValueChange={selectMeasure}
			/>
		</label>

		{#if current?.measure === 'BEYOND_NORMAL'}
			<label class="grid gap-1.5 text-sm font-medium">
				From (hours)
				<Input
					type="number"
					min="0"
					step="0.25"
					value={current.from_hours}
					{disabled}
					oninput={(event) =>
						emit({ ...current, from_hours: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				To (hours, blank = open ended)
				<Input
					type="number"
					min="0"
					step="0.25"
					value={current.to_hours ?? ''}
					{disabled}
					oninput={(event) =>
						emit({ ...current, to_hours: nullableNumberFrom(event.currentTarget.value) })}
				/>
			</label>
		{:else if current?.measure === 'FROM_START_OF_DAY'}
			<label class="grid gap-1.5 text-sm font-medium">
				From (fraction of a normal day)
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.from_fraction}
					{disabled}
					oninput={(event) =>
						emit({ ...current, from_fraction: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				To (fraction, blank = open ended)
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.to_fraction ?? ''}
					{disabled}
					oninput={(event) =>
						emit({ ...current, to_fraction: nullableNumberFrom(event.currentTarget.value) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
