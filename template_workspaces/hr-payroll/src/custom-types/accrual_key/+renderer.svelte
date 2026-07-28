<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { accrualKeySchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type KeyBy = Value['by'];

	const KEY_OPTIONS: { value: KeyBy; label: string; description: string }[] = [
		{
			value: 'SERVICE_MONTHS',
			label: 'Service months',
			description: 'Band applies from N completed months of service'
		},
		{ value: 'FLAT', label: 'Flat', description: 'Same entitlement for everyone' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(accrualKeySchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.by === 'SERVICE_MONTHS' ? `From ${current.band_from} months` : 'Flat';
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(by: KeyBy): Value {
		switch (by) {
			case 'SERVICE_MONTHS':
				return { by: 'SERVICE_MONTHS', band_from: 0 };
			case 'FLAT':
				return { by: 'FLAT' };
		}
	}

	function selectKey(by: KeyBy | null): void {
		if (by === null) {
			emit(null);
			return;
		}
		if (current !== null && current.by === by) return;
		emit(defaultFor(by));
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Keyed by
			<Combobox
				options={KEY_OPTIONS}
				value={current?.by ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a key"
				onValueChange={selectKey}
			/>
		</label>
		{#if current?.by === 'SERVICE_MONTHS'}
			<label class="grid gap-1.5 text-sm font-medium">
				Band from (completed months)
				<Input
					type="number"
					min="0"
					step="1"
					value={current.band_from}
					{disabled}
					oninput={(event) =>
						emit({ by: 'SERVICE_MONTHS', band_from: numberFrom(event.currentTarget.value, 0) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
