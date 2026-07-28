<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { settlementPolicySchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type FinalPeriod = Value['final_period'];

	const FINAL_PERIOD_OPTIONS: { value: FinalPeriod; label: string; description: string }[] = [
		{
			value: 'SETTLE_IN_FINAL_PERIOD',
			label: 'Settle in the final period',
			description: 'The last run covers attendance up to the exit date'
		},
		{
			value: 'FOLLOW_ATTENDANCE_WINDOW',
			label: 'Follow the attendance window',
			description: 'The tail after the cutoff is not measured'
		}
	];

	const EMPTY: Value = {
		late_joiner_arrears: null,
		final_period: 'FOLLOW_ATTENDANCE_WINDOW',
		extended_unpaid_leave: null
	};

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(settlementPolicySchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		const parts = [
			current.late_joiner_arrears ? 'late joiners deferred' : null,
			current.final_period === 'SETTLE_IN_FINAL_PERIOD' ? 'final period settled' : null,
			current.extended_unpaid_leave
				? `extended leave ≥ ${current.extended_unpaid_leave.minimum_calendar_days}d in month`
				: null
		].filter((part) => part !== null);
		return parts.length === 0 ? 'Plain pay calendar' : parts.join(' · ');
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function patch(change: Partial<Value>): void {
		emit({ ...(current ?? EMPTY), ...change });
	}

	function integerFrom(raw: string, fallback: number): number {
		const next = Math.trunc(Number(raw));
		return Number.isFinite(next) ? next : fallback;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Late joiner arrears component id
			<Input
				value={current?.late_joiner_arrears?.defer_to_component_id ?? ''}
				{disabled}
				placeholder="Blank — pay late joiners in the period they join"
				oninput={(event) =>
					patch({
						late_joiner_arrears:
							event.currentTarget.value === ''
								? null
								: { defer_to_component_id: event.currentTarget.value }
					})}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			Final period
			<Combobox
				options={FINAL_PERIOD_OPTIONS}
				value={current?.final_period ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select how a leaver settles"
				onValueChange={(value) =>
					patch({ final_period: (value as FinalPeriod | null) ?? 'FOLLOW_ATTENDANCE_WINDOW' })}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			Extended unpaid leave — minimum calendar days
			<Input
				type="number"
				min="0"
				step="1"
				value={current?.extended_unpaid_leave?.minimum_calendar_days ?? 0}
				{disabled}
				oninput={(event) => {
					const days = integerFrom(event.currentTarget.value, 0);
					patch({
						extended_unpaid_leave:
							days <= 0
								? null
								: {
										minimum_calendar_days: days,
										bridged_gap_days: current?.extended_unpaid_leave?.bridged_gap_days ?? 0,
										population_contribution_id:
											current?.extended_unpaid_leave?.population_contribution_id ?? null
									}
					});
				}}
			/>
		</label>
		{#if current?.extended_unpaid_leave}
			<label class="grid gap-1.5 text-sm font-medium">
				Bridged gap days
				<Input
					type="number"
					min="0"
					step="1"
					value={current.extended_unpaid_leave.bridged_gap_days}
					{disabled}
					oninput={(event) =>
						patch({
							extended_unpaid_leave: {
								...current.extended_unpaid_leave!,
								bridged_gap_days: integerFrom(event.currentTarget.value, 0)
							}
						})}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Population — statutory contribution id
				<Input
					value={current.extended_unpaid_leave.population_contribution_id ?? ''}
					{disabled}
					placeholder="Blank — every employment"
					oninput={(event) =>
						patch({
							extended_unpaid_leave: {
								...current.extended_unpaid_leave!,
								population_contribution_id:
									event.currentTarget.value === '' ? null : event.currentTarget.value
							}
						})}
				/>
			</label>
		{/if}
	</Grid>
{/if}
