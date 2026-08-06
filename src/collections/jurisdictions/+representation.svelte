<script lang="ts">
	/**
	 * One payroll regime, and everything that only exists inside it.
	 *
	 * `statutory_contributions`, `overtime_rules` and `overtime_limits` have no home of their own.
	 * EPF, SOCSO, EIS and PCB are not a catalogue anybody browses across countries; neither is "1.5×
	 * beyond 8 hours" or "104 hours a month". Each is a fact about the jurisdiction that levies or
	 * imposes it — every one of the three carries `jurisdiction_id` as its scoping foreign key — and
	 * reading one apart from that jurisdiction's currency, rounding and ordinary-rate divisor is how a
	 * rule ends up configured against the wrong regime. So they live here, scoped to the record they
	 * belong to, rather than as sibling tabs implying schemes and regimes are peers.
	 *
	 * Rate bands are one level deeper still: `contribution_rates.statutory_contribution_id` points at
	 * a *scheme*, not at a jurisdiction, so a band is configured inside the scheme it prices — open a
	 * contribution below to reach them.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { inForceTodayFilter } from '../../lib/ui/calendar.js';
	import {
		formatCategories,
		formatMoney,
		formatNumeric,
		formatOvertimeAward,
		formatOvertimeBand
	} from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();

	/*
	 * Every rule below is effective-dated, so every table opens on what is in force *today* —
	 * seeded as a removable filter chip rather than a page-level toggle. Each table now says so in
	 * its own filter bar, the operator widens the one table they are reading instead of all five at
	 * once, and clearing the chip is remembered. `inForceTodayFilter()` writes the seed in the
	 * filter builder's vocabulary — a plain calendar day — and the existing conversion turns it
	 * into the instant `contains_date` compares against.
	 *
	 * Every collection listed below carries `effective_range` on itself, which is what the seed
	 * needs: an unknown field is skipped in silence, so a seed pointed at a related collection's
	 * dating would look like a working filter while filtering nothing.
	 */
</script>

{#snippet regime()}
	<CollectionForm
		{client}
		collection="jurisdictions"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		submitLabel={record ? t('component.save_jurisdiction') : t('component.create_jurisdiction')}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field name="code" />
				<Field name="name" />
				<Field name="currency" />
				<Field name="tax_year_start_month" label={t('component.tax_year_start_month')} />
				<Field name="leave_year_start_month" label={t('component.leave_year_start_month')} />
				<Field name="proration" label={t('component.proration_basis')} />
				<Field name="rounding" />
				<Field name="ordinary_rate_basis" label={t('component.ordinary_rate_basis')} />
				<Field name="ordinary_rate_divisor" label={t('component.ordinary_rate_divisor')} />
				<Field name="definition_hash" label={t('component.definition_hash')} />
				<Column span="all"
					><Field name="effective_range" label={t('component.effective_period')} /></Column
				>
			</Grid>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet contributions()}
	{#if record}
		<CollectionTable
			{client}
			collection="statutory_contributions"
			view={`jurisdictions:contributions:${record.norbital_id}`}
			title={t('component.statutory_contributions')}
			description={t('component.statutory_contributions_description')}
			initialFilters={inForceTodayFilter()}
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { sequence: 'asc' }
			}}
			searchPlaceholder={t('component.search_contributions')}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="code" card="title" />
				<TableColumn name="name" card="subtitle" />
				<TableColumn name="authority" />
				<TableColumn name="payer" card="badge" />
				<TableColumn name="keyed_by" label={t('component.keyed_by')} />
				<TableColumn name="rounding" />
				<TableColumn name="sequence" label={t('component.applied_at')} />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet overtimeRules()}
	{#if record}
		<CollectionTable
			{client}
			collection="overtime_rules"
			view={`jurisdictions:overtime-rules:${record.norbital_id}`}
			title={t('component.overtime_rules')}
			description={t('component.overtime_rules_description')}
			initialFilters={inForceTodayFilter()}
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { day_type: 'asc' }
			}}
			searchPlaceholder={t('component.search_overtime_rules')}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="day_type" label={t('component.day_type')} card="title" />
				<TableColumn
					name="band"
					label={t('component.band')}
					card="subtitle"
					render={({ value }) => formatOvertimeBand(value, t)}
				/>
				<TableColumn
					name="award"
					label={t('component.award')}
					card="badge"
					render={({ value }) => formatOvertimeAward(value, t)}
				/>
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet overtimeLimits()}
	{#if record}
		<CollectionTable
			{client}
			collection="overtime_limits"
			view={`jurisdictions:overtime-limits:${record.norbital_id}`}
			title={t('component.overtime_limits')}
			description={t('component.overtime_limits_description')}
			initialFilters={inForceTodayFilter()}
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { period: 'asc' }
			}}
			searchPlaceholder={t('component.search_overtime_limits')}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="period" card="title" />
				<TableColumn
					name="max_hours"
					label={t('component.max_hours')}
					card="subtitle"
					render={({ value, row }) =>
						`${formatNumeric(value)} ${
							row.measures === 'TOTAL_WORK_HOURS'
								? t('component.total_hours_worked')
								: t('component.overtime_hours')
						}`}
				/>
				<TableColumn name="on_exceed" label={t('component.on_exceed')} card="badge" />
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet overtimeCoverage()}
	{#if record}
		<CollectionTable
			{client}
			collection="overtime_coverage_rules"
			view={`jurisdictions:overtime-coverage:${record.norbital_id}`}
			title={t('component.overtime_coverage')}
			description={t('component.overtime_coverage_description')}
			initialFilters={inForceTodayFilter()}
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { authority: 'asc' }
			}}
			searchPlaceholder={t('component.search_coverage_rules')}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn
					name="wage_ceiling"
					label={t('component.wage_ceiling')}
					card="title"
					render={({ value }) => (value ? formatMoney(value, t) : t('component.no_ceiling'))}
				/>
				<TableColumn
					name="wage_basis"
					label={t('component.measured_on')}
					card="subtitle"
					render={({ value, row }) =>
						row.wage_ceiling == null
							? '—'
							: `${value === 'STATUTORY_WAGES' ? t('component.statutory_wages') : t('component.base_salary')}, ${
									row.ceiling_is_inclusive
										? t('component.ceiling_covered')
										: t('component.ceiling_excluded')
								}`}
				/>
				<TableColumn
					name="exempt_categories"
					label={t('component.covered_whatever_the_wage')}
					render={({ value }) => formatCategories(value, t)}
				/>
				<TableColumn
					name="excluded_categories"
					label={t('component.never_covered_short')}
					card="badge"
					render={({ value }) => formatCategories(value, t)}
				/>
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet restBreaks()}
	{#if record}
		<CollectionTable
			{client}
			collection="rest_break_rules"
			view={`jurisdictions:rest-breaks:${record.norbital_id}`}
			title={t('component.rest_and_meal_breaks')}
			description={t('component.rest_and_meal_breaks_description')}
			initialFilters={inForceTodayFilter()}
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { applies_when: 'asc' }
			}}
			searchPlaceholder={t('component.search_break_rules')}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="applies_when" label={t('component.applies')} card="title" />
				<TableColumn
					name="after_consecutive_hours"
					label={t('component.after')}
					card="subtitle"
					render={({ value }) =>
						value == null
							? t('component.no_stated_window')
							: t('component.consecutive_hours', { count: formatNumeric(value) })}
				/>
				<TableColumn
					name="minimum_minutes"
					label={t('component.at_least')}
					card="badge"
					render={({ value }) => t('component.minutes_short', { count: formatNumeric(value) })}
				/>
				<TableColumn
					name="counts_as_worked_time"
					label={t('component.paid')}
					render={({ value }) =>
						value == null
							? t('component.not_stated_by_authority')
							: value
								? t('component.counts_as_worked_time')
								: t('component.unpaid')}
				/>
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#if record}
	{#snippet jurisdictionSummary()}
		<Stack gap="xs">
			<Inline gap="sm" align="baseline">
				<h2 class="truncate text-lg font-semibold">{record.code} · {record.name}</h2>
				<span class="text-sm text-muted-foreground">{record.currency}</span>
			</Inline>
			<p class="text-sm text-muted-foreground">
				{t('component.ordinary_pay_note', {
					divisor: formatNumeric(record.ordinary_rate_divisor),
					unit:
						record.ordinary_rate_basis === 'HOURS_PER_MONTH'
							? t('component.hours_unit')
							: t('component.days_unit')
				})}
			</p>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={jurisdictionSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'regime', label: t('component.regime'), icon: 'lucide:globe', content: regime },
				{
					name: 'contributions',
					label: t('component.statutory_contributions'),
					icon: 'lucide:landmark',
					content: contributions
				},
				{
					name: 'overtime-rules',
					label: t('component.overtime_rules'),
					icon: 'lucide:timer',
					content: overtimeRules
				},
				{
					name: 'overtime-limits',
					label: t('component.overtime_limits'),
					icon: 'lucide:gauge',
					content: overtimeLimits
				},
				{
					name: 'overtime-coverage',
					label: t('component.overtime_coverage'),
					icon: 'lucide:user-check',
					content: overtimeCoverage
				},
				{
					name: 'rest-breaks',
					label: t('component.rest_breaks'),
					icon: 'lucide:coffee',
					content: restBreaks
				}
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render regime()}
{/if}
