<script lang="ts">
	/**
	 * One person's whole file: who they are, the engagements they hold, the terms of each engagement
	 * and where each stands with the statutory schemes.
	 *
	 * These were four sibling tabs in the People app, which meant reading one person required knowing
	 * their employee number and then filtering three unrelated tables by it. They are all facts about
	 * one human being, so they are read from that human being's record.
	 */
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { formatStatutoryFactStatus } from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();

	const approved = { norbital_approval_id: { isNull: true } } as const;

	const employmentsQuery = $derived(
		record == null
			? null
			: client.db.employments.findMany({
					where: { ...approved, employee_id: { eq: record.norbital_id } },
					orderBy: { hire_date: 'desc' },
					limit: 100
				})
	);
	const employments = $derived(employmentsQuery?.current ?? []);
	const employmentIds = $derived(employments.map((employment) => employment.norbital_id));
	const employmentLabelsById = $derived(
		new Map(employments.map((employment) => [employment.norbital_id, employment.employee_number]))
	);
	// One scoped query and a map per relation column, rather than a label lookup per row.
	const companiesQuery = client.db.companies.findMany({ where: approved, limit: 500 });
	const companyLabelsById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company.name]))
	);
	const patternsQuery = client.db.work_patterns.findMany({ where: approved, limit: 500 });
	const patternLabelsById = $derived(
		new Map(
			(patternsQuery.current ?? []).map((pattern) => [
				pattern.norbital_id,
				`${pattern.code} · ${pattern.name}`
			])
		)
	);
	const contributionsQuery = client.db.statutory_contributions.findMany({
		where: approved,
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

{#snippet person()}
	<CollectionForm
		{client}
		collection="employees"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		submitLabel={record ? 'Save person' : 'Add person'}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field name="name" />
				<Field name="email" />
				<Field name="phone" />
				<Field name="date_of_birth" label="Date of birth" />
				<Field name="nationality" />
				<Field name="identity_number" label="Identity number" />
				<Field name="gender" />
				<Field name="marital_status" label="Marital status" />
				<Field name="spouse_status" label="Spouse" />
				<Field name="dependents_count" label="Dependents" />
				<Column span="all"><Field name="address" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet engagements()}
	{#if record}
		<CollectionTable
			{client}
			collection="employments"
			view={`employees:employments:${record.norbital_id}`}
			title="Employments"
			description="One row per company this person works for. hire_date drives service months and every leave accrual."
			query={{
				where: { employee_id: { eq: record.norbital_id } },
				orderBy: { hire_date: 'desc' }
			}}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="employee_number" card="title" />
				<TableColumn
					name="company_id"
					label="Legal entity"
					card="subtitle"
					render={({ value }) =>
						value == null || value === '' ? '—' : (companyLabelsById.get(String(value)) ?? '—')}
				/>
				<TableColumn name="hire_date" label="Hired" />
				<TableColumn name="exit_date" label="Exited" />
				<TableColumn name="exit_reason" label="Exit reason" />
				<TableColumn name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet terms()}
	<CollectionTable
		{client}
		collection="employment_terms"
		view={`employees:terms:${record?.norbital_id ?? 'none'}`}
		title="Contractual terms"
		description="Effective-dated pay and classification for each engagement. End-date and insert a successor; never update in place."
		query={{
			where: { employment_id: { in: employmentIds } },
			orderBy: { norbital_created_at: 'desc' }
		}}
	>
		{#snippet columns({ Column: TableColumn })}
			<TableColumn
				name="employment_id"
				label="Employment"
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn name="base_salary" label="Base salary" card="subtitle" />
			<TableColumn name="pay_frequency" label="Frequency" card="badge" />
			<TableColumn name="job_title" label="Job title" />
			<TableColumn name="employment_type" label="Type" />
			<TableColumn name="work_classification" label="Classification" />
			<TableColumn
				name="work_pattern_id"
				label="Work pattern"
				render={({ value }) =>
					value == null || value === '' ? '—' : (patternLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet statutoryFacts()}
	<CollectionTable
		{client}
		collection="employment_statutory_facts"
		view={`employees:statutory-facts:${record?.norbital_id ?? 'none'}`}
		title="Statutory registrations"
		description="Where each engagement stands with each statutory scheme — registered with a reference, or not registered with a reason."
		query={{
			where: { employment_id: { in: employmentIds } },
			orderBy: { norbital_created_at: 'desc' }
		}}
	>
		{#snippet columns({ Column: TableColumn })}
			<TableColumn
				name="employment_id"
				label="Employment"
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn
				name="statutory_contribution_id"
				label="Contribution"
				card="subtitle"
				render={({ value }) =>
					value == null || value === '' ? '—' : (contributionLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn
				name="status"
				label="Registration"
				render={({ value }) => formatStatutoryFactStatus(value)}
			/>
			<TableColumn name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#if record}
	{#snippet personSummary()}
		<Stack gap="xs">
			<Inline gap="sm" align="baseline">
				<h2 class="truncate text-lg font-semibold">{record.name}</h2>
				<span class="text-sm text-muted-foreground">
					{employments.length}
					{employments.length === 1 ? 'employment' : 'employments'}
				</span>
			</Inline>
			<p class="text-sm text-muted-foreground">
				{record.email ?? 'No email recorded'} · {record.nationality ?? 'Nationality not recorded'}
			</p>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={personSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'person', label: 'Person', icon: 'lucide:user', content: person },
				{
					name: 'employments',
					label: 'Employments',
					icon: 'lucide:briefcase',
					content: engagements
				},
				{ name: 'terms', label: 'Terms', icon: 'lucide:file-signature', content: terms },
				{
					name: 'statutory-facts',
					label: 'Statutory facts',
					icon: 'lucide:id-card',
					content: statutoryFacts
				}
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render person()}
{/if}
