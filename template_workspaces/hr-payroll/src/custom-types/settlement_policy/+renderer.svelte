<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	const { t } = useI18n<TenantI18nKeys>();

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

	const FINAL_PERIOD_OPTIONS = $derived<
		{ value: FinalPeriod; label: string; description: string }[]
	>([
		{
			value: 'SETTLE_IN_FINAL_PERIOD',
			label: t('renderer.settlement_policy.settle_final_period'),
			description: t('renderer.settlement_policy.settle_final_period_desc')
		},
		{
			value: 'FOLLOW_ATTENDANCE_WINDOW',
			label: t('renderer.settlement_policy.follow_attendance_window'),
			description: t('renderer.settlement_policy.follow_attendance_window_desc')
		}
	]);

	const FINAL_PERIOD_WAGES_OPTIONS = $derived<
		{ value: FinalPeriodWages; label: string; description: string }[]
	>([
		{
			value: 'PRORATE_TO_EXIT',
			label: t('renderer.settlement_policy.prorate_to_exit'),
			description: t('renderer.settlement_policy.prorate_to_exit_desc')
		},
		{
			value: 'FULL_PERIOD',
			label: t('renderer.settlement_policy.full_period'),
			description: t('renderer.settlement_policy.full_period_desc')
		}
	]);

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
			current.late_joiner_arrears
				? t('renderer.settlement_policy.summary_late_joiners_deferred')
				: null,
			current.final_period === 'SETTLE_IN_FINAL_PERIOD'
				? t('renderer.settlement_policy.summary_final_period_settled')
				: null,
			current.final_period_wages === 'FULL_PERIOD'
				? t('renderer.settlement_policy.summary_full_period_wages')
				: null,
			current.extended_unpaid_leave
				? t('renderer.settlement_policy.summary_extended_leave', {
						days: current.extended_unpaid_leave.minimum_calendar_days
					})
				: null
		].filter((part) => part !== null);
		return parts.length === 0
			? t('renderer.settlement_policy.summary_plain_calendar')
			: parts.join(' · ');
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
			{t('renderer.settlement_policy.late_joiners_paid_on')}
			<Combobox
				ariaLabel={t('renderer.settlement_policy.aria_late_joiner_component')}
				options={componentOptions}
				value={current?.late_joiner_arrears?.defer_to_component_id ?? null}
				disabled={disabled || companyId == null}
				searchPlaceholder={t('component.search_pay_components')}
				emptyPlaceholder={t('renderer.settlement_policy.nothing_deferred')}
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
				{t('renderer.settlement_policy.hint_arrears_component')}
			</span>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			{t('renderer.settlement_policy.final_period')}
			<Combobox
				ariaLabel={t('renderer.settlement_policy.final_period')}
				options={FINAL_PERIOD_OPTIONS}
				value={current?.final_period ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.settlement_policy.select_leaver_settles')}
				onValueChange={(value) =>
					patch({ final_period: (value as FinalPeriod | null) ?? 'FOLLOW_ATTENDANCE_WINDOW' })}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			{t('renderer.settlement_policy.final_period_wages')}
			<Combobox
				ariaLabel={t('renderer.settlement_policy.final_period_wages')}
				options={FINAL_PERIOD_WAGES_OPTIONS}
				value={current?.final_period_wages ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.settlement_policy.select_final_wages_measure')}
				onValueChange={(value) =>
					patch({
						final_period_wages: (value as FinalPeriodWages | null) ?? 'PRORATE_TO_EXIT'
					})}
			/>
		</label>
		<label class="grid gap-1.5 text-sm font-medium">
			{t('renderer.settlement_policy.extended_leave_min_days')}
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
				{t('renderer.settlement_policy.bridged_gap_days')}
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
				{t('renderer.settlement_policy.applies_to_employments')}
				<Combobox
					ariaLabel={t('renderer.settlement_policy.aria_extended_population')}
					options={contributionOptions}
					value={current.extended_unpaid_leave.population_contribution_id}
					{disabled}
					searchPlaceholder={t('renderer.settlement_policy.search_statutory_schemes')}
					emptyPlaceholder={t('renderer.settlement_policy.every_employment')}
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
