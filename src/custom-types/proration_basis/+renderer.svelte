<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { prorationBasisSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';
	const { t } = useI18n<TenantI18nKeys>();

	type Basis = Value['by'];

	const BASIS_OPTIONS: { value: Basis; label: string; description: string }[] = [
		{ value: 'CALENDAR_DAYS', label: 'Calendar days', description: 'Days in the calendar month' },
		{ value: 'WORKING_DAYS', label: 'Working days', description: 'Scheduled working days' },
		{ value: 'FIXED_DAYS', label: 'Fixed days', description: 'A fixed statutory divisor' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(prorationBasisSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.by === 'FIXED_DAYS') return `Fixed ${current.days} days`;
		return current.by === 'CALENDAR_DAYS' ? 'Calendar days' : 'Working days';
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(basis: Basis): Value {
		switch (basis) {
			case 'CALENDAR_DAYS':
				return { by: 'CALENDAR_DAYS' };
			case 'WORKING_DAYS':
				return { by: 'WORKING_DAYS' };
			case 'FIXED_DAYS':
				return { by: 'FIXED_DAYS', days: 26 };
		}
	}

	function selectBasis(basis: Basis | null): void {
		if (basis === null) {
			emit(null);
			return;
		}
		if (current !== null && current.by === basis) return;
		emit(defaultFor(basis));
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
			Proration basis
			<Combobox
				options={BASIS_OPTIONS}
				value={current?.by ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.proration_basis.select_basis')}
				onValueChange={selectBasis}
			/>
		</label>
		{#if current?.by === 'FIXED_DAYS'}
			<label class="grid gap-1.5 text-sm font-medium">
				Days
				<Input
					type="number"
					min="0.5"
					step="0.5"
					value={current.days}
					{disabled}
					oninput={(event) =>
						emit({ by: 'FIXED_DAYS', days: numberFrom(event.currentTarget.value, 1) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
