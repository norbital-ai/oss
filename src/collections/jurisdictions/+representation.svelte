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
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { ToggleGroup, ToggleGroupItem } from '@norbital-ai/ui/toggle-group';
	import { todayInstant } from '../../lib/ui/calendar.js';
	import {
		formatNumeric,
		formatOvertimeAward,
		formatOvertimeBand
	} from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();

	/**
	 * Every rule below is effective-dated, so every table opens on what is in force *today* and
	 * widens only when the operator asks. `contains_date` compares against a `dateRange()` bound,
	 * which is an instant: `todayInstant()` resolves the payroll timezone, while a bare calendar day
	 * is rejected by the query layer.
	 */
	let effectiveWindow = $state<'current' | 'history'>('current');
	const effectiveRange: { effective_range?: { contains_date: string } } = $derived(
		effectiveWindow === 'history' ? {} : { effective_range: { contains_date: todayInstant() } }
	);
</script>

{#snippet regime()}
	<CollectionForm
		{client}
		collection="jurisdictions"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		submitLabel={record ? 'Save jurisdiction' : 'Create jurisdiction'}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field name="code" />
				<Field name="name" />
				<Field name="currency" />
				<Field name="tax_year_start_month" label="Tax year starts (month)" />
				<Field name="leave_year_start_month" label="Leave year starts (month)" />
				<Field name="proration" label="Proration basis" />
				<Field name="rounding" />
				<Field name="ordinary_rate_basis" label="Ordinary rate basis" />
				<Field name="ordinary_rate_divisor" label="Ordinary rate divisor" />
				<Field name="definition_hash" label="Definition hash" />
				<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
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
			title="Statutory contributions"
			description="The schemes this regime levies, in the order payroll applies them. Open one for the rate bands that price it — a band belongs to a scheme, not to the jurisdiction."
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id }, ...effectiveRange },
				orderBy: { sequence: 'asc' }
			}}
			searchPlaceholder="Search contributions…"
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="code" card="title" />
				<TableColumn name="name" card="subtitle" />
				<TableColumn name="authority" />
				<TableColumn name="payer" card="badge" />
				<TableColumn name="keyed_by" label="Keyed by" />
				<TableColumn name="rounding" />
				<TableColumn name="sequence" label="Applied at" />
				<TableColumn name="effective_range" label="Effective" />
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
			title="Overtime rules"
			description="What an hour beyond normal is worth here: one band of hours (or fractions of a normal day) on one kind of day, and the multiple it pays."
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id }, ...effectiveRange },
				orderBy: { day_type: 'asc' }
			}}
			searchPlaceholder="Search overtime rules…"
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="day_type" label="Day type" card="title" />
				<TableColumn
					name="band"
					label="Band"
					card="subtitle"
					render={({ value }) => formatOvertimeBand(value)}
				/>
				<TableColumn
					name="award"
					label="Award"
					card="badge"
					render={({ value }) => formatOvertimeAward(value)}
				/>
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label="Effective" />
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
			title="Overtime limits"
			description="The statutory ceiling on overtime hours per day, week or month, and whether exceeding it warns or blocks."
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id }, ...effectiveRange },
				orderBy: { period: 'asc' }
			}}
			searchPlaceholder="Search overtime limits…"
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="period" card="title" />
				<TableColumn
					name="max_hours"
					label="Max hours"
					card="subtitle"
					render={({ value }) => formatNumeric(value)}
				/>
				<TableColumn name="on_exceed" label="On exceed" card="badge" />
				<TableColumn name="authority" />
				<TableColumn name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#if record}
	{#snippet jurisdictionSummary()}
		<Stack gap="sm">
			<Stack gap="xs">
				<Inline gap="sm" align="baseline">
					<h2 class="truncate text-lg font-semibold">{record.code} · {record.name}</h2>
					<span class="text-sm text-muted-foreground">{record.currency}</span>
				</Inline>
				<p class="text-sm text-muted-foreground">
					Ordinary pay is divided by {formatNumeric(record.ordinary_rate_divisor)}
					{record.ordinary_rate_basis === 'HOURS_PER_MONTH' ? 'hours' : 'days'} a month. Every rule here
					is effective-dated — end-date and insert a successor, never update in place.
				</p>
			</Stack>
			<Inline gap="sm" align="center">
				<span class="text-sm font-medium text-muted-foreground">Effective</span>
				<ToggleGroup
					type="single"
					size="sm"
					value={effectiveWindow}
					onValueChange={(value) => {
						effectiveWindow = value === 'history' ? 'history' : 'current';
					}}
				>
					<ToggleGroupItem value="current" aria-label="Show only what is in force today">
						In force today
					</ToggleGroupItem>
					<ToggleGroupItem
						value="history"
						aria-label="Show every version, including superseded ones"
					>
						All history
					</ToggleGroupItem>
				</ToggleGroup>
			</Inline>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={jurisdictionSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'regime', label: 'Regime', icon: 'lucide:globe', content: regime },
				{
					name: 'contributions',
					label: 'Statutory contributions',
					icon: 'lucide:landmark',
					content: contributions
				},
				{
					name: 'overtime-rules',
					label: 'Overtime rules',
					icon: 'lucide:timer',
					content: overtimeRules
				},
				{
					name: 'overtime-limits',
					label: 'Overtime limits',
					icon: 'lucide:gauge',
					content: overtimeLimits
				}
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render regime()}
{/if}
