<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import {
		formatComponentDefinition,
		formatNumeric,
		formatOvertimeAward,
		formatOvertimeBand,
		formatProrationBasis,
		formatRateAward,
		formatRateSelector,
		formatStatutoryFactStatus
	} from '../../lib/ui/display-formatters.js';

	// A relation column holds a uuid. Every configuration table on this page points at one of these
	// four reference sets, so they are loaded once here and the label is resolved from memory rather
	// than by mounting a lookup per row. A miss falls back to the raw id, because a label this page
	// has not loaded must not read as missing data.
	const jurisdictionsQuery = client.db.jurisdictions.findMany({
		where: { norbital_approval_id: { isNull: true } },
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
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const companyLabelsById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company.name]))
	);
	const componentTypesQuery = client.db.component_types.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	const componentTypeLabelsById = $derived(
		new Map((componentTypesQuery.current ?? []).map((type) => [type.norbital_id, type.name]))
	);
	const contributionsQuery = client.db.statutory_contributions.findMany({
		where: { norbital_approval_id: { isNull: true } },
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
	const employmentsQuery = client.db.employments.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 1000
	});
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);
</script>

<svelte:head>
	<title>HR Settings</title>
	<meta
		name="description"
		content="Manage jurisdictions, statutory contributions and their rates, overtime rules, accrual bands, companies, and the pay catalogue"
	/>
	<meta name="pod:icon" content="lucide:settings-2" />
</svelte:head>

{#snippet jurisdictions()}
	<CollectionTable {client} collection="jurisdictions" query={{ orderBy: { code: 'asc' } }}>
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
	<CollectionTable {client} collection="companies" query={{ orderBy: { name: 'asc' } }}>
		{#snippet columns({ Column })}
			<Column name="name" card="title" />
			<Column name="registration_number" card="subtitle" />
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				render={({ value }) => jurisdictionLabelsById.get(String(value)) ?? value}
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

{#snippet componentTypes()}
	<CollectionTable {client} collection="component_types" query={{ orderBy: { sequence: 'asc' } }}>
		{#snippet columns({ Column })}
			<Column name="sequence" label="Seq" />
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column name="nature" card="badge" />
			<Column name="description" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet payComponents()}
	<CollectionTable {client} collection="pay_components" query={{ orderBy: { code: 'asc' } }}>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="company_id"
				label="Company"
				render={({ value }) => companyLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="component_type_id"
				label="Component type"
				render={({ value }) => componentTypeLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="definition"
				label="Definition"
				render={({ value }) => formatComponentDefinition(value)}
			/>
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet contributions()}
	<CollectionTable
		{client}
		collection="statutory_contributions"
		query={{ orderBy: { sequence: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				render={({ value }) => jurisdictionLabelsById.get(String(value)) ?? value}
			/>
			<Column name="authority" />
			<Column name="payer" card="badge" />
			<Column name="keyed_by" label="Keyed by" />
			<Column name="rounding" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet rates()}
	<CollectionTable
		{client}
		collection="contribution_rates"
		query={{ orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="statutory_contribution_id"
				label="Contribution"
				card="title"
				render={({ value }) => contributionLabelsById.get(String(value)) ?? value}
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

{#snippet treatments()}
	<CollectionTable
		{client}
		collection="contribution_treatments"
		query={{ orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="component_type_id"
				label="Component type"
				card="title"
				render={({ value }) => componentTypeLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="statutory_contribution_id"
				label="Contribution"
				card="subtitle"
				render={({ value }) => contributionLabelsById.get(String(value)) ?? value}
			/>
			<Column name="authority" />
			<Column name="treatment" label="Treatment" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet overtime()}
	<CollectionTable
		{client}
		collection="overtime_rules"
		query={{ orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				card="title"
				render={({ value }) => jurisdictionLabelsById.get(String(value)) ?? value}
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
		query={{ orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				card="title"
				render={({ value }) => jurisdictionLabelsById.get(String(value)) ?? value}
			/>
			<Column name="period" card="badge" />
			<Column name="max_hours" label="Max hours" render={({ value }) => formatNumeric(value)} />
			<Column name="on_exceed" label="On exceed" />
			<Column name="authority" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet bands()}
	<CollectionTable {client} collection="accrual_bands" query={{ orderBy: { leave_code: 'asc' } }}>
		{#snippet columns({ Column })}
			<Column name="leave_code" label="Leave code" card="title" />
			<Column name="days" render={({ value }) => formatNumeric(value)} />
			<Column name="key" label="Band key" card="subtitle" />
			<Column name="owner" label="Owner" />
			<Column name="authority" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet statutoryFacts()}
	<CollectionTable
		{client}
		collection="employment_statutory_facts"
		query={{ orderBy: { norbital_created_at: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="employment_id"
				label="Employment"
				card="title"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="statutory_contribution_id"
				label="Contribution"
				card="subtitle"
				render={({ value }) => contributionLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="status"
				label="Registration"
				render={({ value }) => formatStatutoryFactStatus(value)}
			/>
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Settings"
		description="Statutory regimes on the left of the schema, company configuration on the right. Every rule is effective-dated: end-date and insert a successor, never update in place."
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
			{
				name: 'component-types',
				label: 'Component types',
				icon: 'lucide:shapes',
				content: componentTypes
			},
			{
				name: 'pay-components',
				label: 'Pay catalogue',
				icon: 'lucide:list-tree',
				content: payComponents
			},
			{
				name: 'contributions',
				label: 'Contributions',
				icon: 'lucide:landmark',
				content: contributions
			},
			{ name: 'rates', label: 'Rates', icon: 'lucide:percent', content: rates },
			{ name: 'treatments', label: 'Treatments', icon: 'lucide:shield-check', content: treatments },
			{ name: 'overtime', label: 'Overtime rules', icon: 'lucide:timer', content: overtime },
			{ name: 'limits', label: 'Overtime limits', icon: 'lucide:gauge', content: limits },
			{ name: 'accrual-bands', label: 'Accrual bands', icon: 'lucide:layers', content: bands },
			{
				name: 'statutory-facts',
				label: 'Statutory facts',
				icon: 'lucide:id-card',
				content: statutoryFacts
			}
		] satisfies TabConfig[]}
	/>
</Cover>
