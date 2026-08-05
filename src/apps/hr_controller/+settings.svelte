<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { todayKey, todayInstant } from '../../lib/ui/calendar.js';
	import {
		formatNumeric,
		formatOvertimeAward,
		formatOvertimeBand,
		formatProrationBasis,
		formatRateAward,
		formatRateSelector
	} from '../../lib/ui/display-formatters.js';

	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	// Relation columns hold uuids; resolve labels from one loaded set. Miss → em dash, never the uuid.
	const jurisdictionsQuery = client.db.jurisdictions.findMany({
		where: { norbital_approval_id: { isNull: true }, ...activeRange },
		limit: 200
	});
	const jurisdictionLabelsById = $derived(
		new Map(
			(jurisdictionsQuery.current ?? []).map((jurisdiction) => [
				jurisdiction.norbital_id,
				jurisdiction.name
			])
		)
	);
	const contributionsQuery = client.db.statutory_contributions.findMany({
		where: { norbital_approval_id: { isNull: true }, ...activeRange },
		limit: 500
	});
	const contributionLabelsById = $derived(
		new Map(
			(contributionsQuery.current ?? []).map((contribution) => [
				contribution.norbital_id,
				`${contribution.code} · ${contribution.name}`
			])
		)
	);
</script>

<svelte:head>
	<title>Statutory profile</title>
	<meta
		name="description"
		content="The regime every payroll is calculated against: jurisdictions and the schemes inside them, the companies bound to each, contribution rates, and overtime rules and limits"
	/>
	<meta name="pod:icon" content="lucide:scale" />
</svelte:head>

{#snippet jurisdictions()}
	<CollectionTable
		{client}
		collection="jurisdictions"
		title="Jurisdictions"
		description="Open a jurisdiction to configure the statutory schemes it levies — they belong to the regime, not to a catalogue of their own."
		query={{ where: { ...activeRange }, orderBy: { code: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column name="currency" />
			<Column name="proration" render={({ value }) => formatProrationBasis(value)} />
			<Column name="rounding" />
			<Column name="ordinary_rate_basis" label="Ordinary rate basis" />
			<Column
				name="ordinary_rate_divisor"
				label="Divisor"
				render={({ value }) => formatNumeric(value)}
			/>
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet companies()}
	<CollectionTable
		{client}
		collection="companies"
		query={{ where: { ...activeRange }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="name" card="title" />
			<Column name="registration_number" card="subtitle" />
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				render={({ value }) =>
					value == null || value === '' ? '—' : (jurisdictionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="pay_cutoff_day" label="Cutoff day" />
			<Column name="pay_day" label="Pay day" />
			<Column name="leave_year_start_month" label="Leave year starts" />
			<Column name="overtime_calculation_method" label="OT calculation" />
			<Column name="risk_class" label="Risk class" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet rates()}
	<CollectionTable
		{client}
		collection="contribution_rates"
		query={{ where: { ...activeRange }, orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="statutory_contribution_id"
				label="Contribution"
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (contributionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column
				name="selector"
				label="Selector"
				card="subtitle"
				render={({ value }) => formatRateSelector(value)}
			/>
			<Column name="award" label="Award" render={({ value }) => formatRateAward(value)} />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet overtime()}
	<CollectionTable
		{client}
		collection="overtime_rules"
		query={{ where: { ...activeRange }, orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (jurisdictionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="day_type" label="Day type" card="badge" />
			<Column
				name="band"
				label="Band"
				card="subtitle"
				render={({ value }) => formatOvertimeBand(value)}
			/>
			<Column name="award" label="Award" render={({ value }) => formatOvertimeAward(value)} />
			<Column name="authority" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet limits()}
	<CollectionTable
		{client}
		collection="overtime_limits"
		query={{ where: { ...activeRange }, orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (jurisdictionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="period" card="badge" />
			<Column name="max_hours" label="Max hours" render={({ value }) => formatNumeric(value)} />
			<Column name="on_exceed" label="On exceed" />
			<Column name="authority" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Statutory profile"
		description="The regime payroll is calculated against: jurisdictions, the companies bound to one, and the contribution and overtime rules a jurisdiction sets. Each statutory scheme is configured inside its own jurisdiction; the pay catalogue lives under Pay components and per-person registrations under People. Every rule is effective-dated — end-date and insert a successor, never update in place."
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'jurisdictions',
				label: 'Jurisdictions',
				icon: 'lucide:globe',
				content: jurisdictions
			},
			{ name: 'companies', label: 'Companies', icon: 'lucide:building-2', content: companies },
			{ name: 'rates', label: 'Rates', icon: 'lucide:percent', content: rates },
			{ name: 'overtime', label: 'Overtime rules', icon: 'lucide:timer', content: overtime },
			{ name: 'limits', label: 'Overtime limits', icon: 'lucide:gauge', content: limits }
		] satisfies TabConfig[]}
	/>
</Cover>
