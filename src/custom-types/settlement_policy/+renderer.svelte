<script lang="ts">
	/**
	 * The two ids inside this variant are foreign keys the database cannot declare, so nothing
	 * resolves them for us: a `custom()` column is one JSONB value, and `RelationshipRenderer` only
	 * attaches to a `Field` whose whole value is the id. They are therefore picked here, from
	 * inline queries scoped to the company this policy belongs to — the same option set a column FK
	 * would have offered, assembled by the renderer that owns the variant.
	 */
	import { client } from '$pod/client';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { settlementPolicySchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type FinalPeriod = Value['final_period'];
	type FinalPeriodWages = Value['final_period_wages'];
	type SettlementPolicyRendererProps = RendererProps & {
		/** The company row being edited, which is what scopes the pay catalogue below. */
		readonly row?: Record<string, unknown>;
	};

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

	const FINAL_PERIOD_WAGES_OPTIONS: {
		value: FinalPeriodWages;
		label: string;
		description: string;
	}[] = [
		{
			value: 'PRORATE_TO_EXIT',
			label: 'Prorate to the exit date',
			description: 'Recurring wages cover only the employment days in the final period'
		},
		{
			value: 'FULL_PERIOD',
			label: 'Pay the full period',
			description: 'Full wages, with the period’s attendance deductions applied separately'
		}
	];

	/**
	 * A stated policy that behaves exactly as no policy at all — `PLAIN_CALENDAR` in
	 * `payroll_runs/lib/settlement.ts`. Every key of the strict object is present, because a
	 * partial object fails validation on write and the company would silently keep its old policy.
	 */
	const EMPTY: Value = {
		late_joiner_arrears: null,
		final_period: 'FOLLOW_ATTENDANCE_WINDOW',
		final_period_wages: 'PRORATE_TO_EXIT',
		extended_unpaid_leave: null,
		absence_proration: null,
		overtime_windows: null
	};

	let props: SettlementPolicyRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(settlementPolicySchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);

	const companyId = $derived(
		typeof props.row?.norbital_id === 'string' ? props.row.norbital_id : null
	);
	// Only an ENTRY component can carry a deferred joining period — `companies/+hooks.ts` refuses
	// any other source — so the picker offers exactly what the hook would accept.
	const componentsQuery = $derived(
		companyId == null
			? null
			: client.db.pay_components.findMany({
					where: { company_id: { eq: companyId } },
					orderBy: { code: 'asc' },
					limit: 500
				})
	);
	const componentOptions = $derived(
		(componentsQuery?.current ?? [])
			.filter((component) => component.definition?.source === 'ENTRY')
			.map((component) => ({
				value: component.norbital_id,
				label: [component.code, component.name].filter((part) => part).join(' · ') || '—',
				search_term: `${component.code ?? ''} ${component.name ?? ''}`
			}))
	);
	const contributionsQuery = client.db.statutory_contributions.findMany({
		orderBy: { code: 'asc' },
		limit: 500
	});
	const contributionOptions = $derived(
		(contributionsQuery.current ?? []).map((contribution) => ({
			value: contribution.norbital_id,
			label: [contribution.code, contribution.name].filter((part) => part).join(' · ') || '—',
			search_term: `${contribution.code ?? ''} ${contribution.name ?? ''}`
		}))
	);

	const summary = $derived.by(() => {
		if (current === null) return '—';
		const parts = [
			current.late_joiner_arrears ? 'late joiners deferred' : null,
			current.final_period === 'SETTLE_IN_FINAL_PERIOD' ? 'final period settled' : null,
			current.final_period_wages === 'FULL_PERIOD' ? 'full final-period wages' : null,
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
			Late joiners are paid on
			<Combobox
				ariaLabel="Late joiner arrears component"
				options={componentOptions}
				value={current?.late_joiner_arrears?.defer_to_component_id ?? null}
				disabled={disabled || companyId == null}
				searchPlaceholder="Search pay components…"
				emptyPlaceholder="Nothing deferred — pay late joiners in the period they join"
				clientConfig={{
					isLoading: componentsQuery?.loading ?? false,
					error: componentsQuery?.error?.message ?? null
				}}
				onValueChange={(value) =>
					patch({
						late_joiner_arrears:
							typeof value === 'string' && value !== '' ? { defer_to_component_id: value } : null
					})}
			/>
			<span class="text-xs font-normal text-muted-foreground">
				The arrears component a skipped joining period is paid out on in the next run. Only
				components measured from an entry can carry one.
			</span>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			Final period
			<Combobox
				ariaLabel="Final period"
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
			Final period wages
			<Combobox
				ariaLabel="Final period wages"
				options={FINAL_PERIOD_WAGES_OPTIONS}
				value={current?.final_period_wages ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select how a leaver’s recurring wages are measured"
				onValueChange={(value) =>
					patch({
						final_period_wages: (value as FinalPeriodWages | null) ?? 'PRORATE_TO_EXIT'
					})}
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
				Applies to employments registered for
				<Combobox
					ariaLabel="Extended leave population"
					options={contributionOptions}
					value={current.extended_unpaid_leave.population_contribution_id}
					{disabled}
					searchPlaceholder="Search statutory schemes…"
					emptyPlaceholder="Every employment"
					clientConfig={{
						isLoading: contributionsQuery.loading,
						error: contributionsQuery.error?.message ?? null
					}}
					onValueChange={(value) =>
						patch({
							extended_unpaid_leave: {
								...current.extended_unpaid_leave!,
								population_contribution_id: typeof value === 'string' && value !== '' ? value : null
							}
						})}
				/>
			</label>
		{/if}
	</Grid>
{/if}
