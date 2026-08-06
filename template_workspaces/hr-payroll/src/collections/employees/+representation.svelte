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
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { formatStatutoryFactStatus } from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();

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
		submitLabel={record ? t('component.save_person') : t('component.add_person')}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field name="name" />
				<Field name="email" />
				<Field name="phone" />
				<Field name="date_of_birth" label={t('component.date_of_birth')} />
				<Field name="nationality" />
				<Field name="identity_number" label={t('component.identity_number')} />
				<Field name="gender" />
				<Field name="marital_status" label={t('component.marital_status')} />
				<Field name="spouse_status" label={t('component.spouse')} />
				<Field name="dependents_count" label={t('component.dependents')} />
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
			title={t('component.employments')}
			description={t('component.employments_description')}
			query={{
				where: { employee_id: { eq: record.norbital_id } },
				orderBy: { hire_date: 'desc' }
			}}
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="employee_number" card="title" />
				<TableColumn
					name="company_id"
					label={t('component.legal_entity')}
					card="subtitle"
					render={({ value }) =>
						value == null || value === '' ? '—' : (companyLabelsById.get(String(value)) ?? '—')}
				/>
				<TableColumn name="hire_date" label={t('component.hired')} />
				<TableColumn name="exit_date" label={t('component.exited')} />
				<TableColumn name="exit_reason" label={t('component.exit_reason')} />
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet terms()}
	<CollectionTable
		{client}
		collection="employment_terms"
		view={`employees:terms:${record?.norbital_id ?? 'none'}`}
		title={t('component.contractual_terms')}
		description={t('component.contractual_terms_description')}
		query={{
			where: { employment_id: { in: employmentIds } },
			orderBy: { norbital_created_at: 'desc' }
		}}
	>
		{#snippet columns({ Column: TableColumn })}
			<TableColumn
				name="employment_id"
				label={t('component.employment')}
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn name="base_salary" label={t('component.base_salary')} card="subtitle" />
			<TableColumn name="pay_frequency" label={t('component.frequency')} card="badge" />
			<TableColumn name="job_title" label={t('component.job_title')} />
			<TableColumn name="employment_type" label={t('component.type')} />
			<TableColumn name="work_classification" label={t('component.classification')} />
			<TableColumn
				name="work_pattern_id"
				label={t('component.work_pattern')}
				render={({ value }) =>
					value == null || value === '' ? '—' : (patternLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn name="effective_range" label={t('component.effective')} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet statutoryFacts()}
	<CollectionTable
		{client}
		collection="employment_statutory_facts"
		view={`employees:statutory-facts:${record?.norbital_id ?? 'none'}`}
		title={t('component.statutory_registrations')}
		description={t('component.statutory_registrations_description')}
		query={{
			where: { employment_id: { in: employmentIds } },
			orderBy: { norbital_created_at: 'desc' }
		}}
	>
		{#snippet columns({ Column: TableColumn })}
			<TableColumn
				name="employment_id"
				label={t('component.employment')}
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn
				name="statutory_contribution_id"
				label={t('component.contribution')}
				card="subtitle"
				render={({ value }) =>
					value == null || value === '' ? '—' : (contributionLabelsById.get(String(value)) ?? '—')}
			/>
			<TableColumn
				name="status"
				label={t('component.registration')}
				render={({ value }) => formatStatutoryFactStatus(value, t)}
			/>
			<TableColumn name="effective_range" label={t('component.effective')} />
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
					{t('component.employment_count', {
						count: employments.length,
						s: employments.length === 1 ? '' : 's'
					})}
				</span>
			</Inline>
			<p class="text-sm text-muted-foreground">
				{record.email ?? t('component.no_email_recorded')} · {record.nationality ??
					t('component.nationality_not_recorded')}
			</p>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={personSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'person', label: t('component.person'), icon: 'lucide:user', content: person },
				{
					name: 'employments',
					label: t('component.employments'),
					icon: 'lucide:briefcase',
					content: engagements
				},
				{
					name: 'terms',
					label: t('component.terms'),
					icon: 'lucide:file-signature',
					content: terms
				},
				{
					name: 'statutory-facts',
					label: t('component.statutory_facts'),
					icon: 'lucide:id-card',
					content: statutoryFacts
				}
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render person()}
{/if}
