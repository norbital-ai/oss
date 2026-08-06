<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const { t } = useI18n<TenantI18nKeys>();

	const projectsQuery = client.db.projects.findMany({
		columns: { norbital_id: true, project_name: true, project_number: true },
		orderBy: { project_name: 'asc' },
		limit: 500
	});
	const projectLabelsById = $derived(
		new Map(
			(projectsQuery.current ?? []).map((project) => [
				project.norbital_id,
				project.project_number
					? `${project.project_number} · ${project.project_name}`
					: project.project_name
			])
		)
	);
</script>

<svelte:head>
	<title>Construction Workforce Settings</title>
	<meta name="description" content="Manage workers, certifications, and job requirements." />
	<meta name="pod:icon" content="lucide:users" />
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/construction/app-media/construction_settings_workforce-banner.svg"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/construction/app-media/construction_settings_workforce-banner.svg"
	/>
</svelte:head>

{#snippet workers()}
	<CollectionTable {client} collection="workers">
		{#snippet columns({ Column })}
			<Column name="worker_name" />
			<Column name="worker_number" />
			<Column name="trade" />
			<Column name="status" />
			<Column name="phone" />
			<Column name="email" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet certifications()}
	<CollectionTable {client} collection="certification_types">
		{#snippet columns({ Column })}
			<Column name="certification_name" />
			<Column name="certification_code" />
			<Column name="category" />
			<Column name="issuing_body" />
			<Column name="validity_period_months" />
			<Column name="requires_refresher" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet jobRequirements()}
	<CollectionTable {client} collection="jobs" view="construction_workforce:jobs">
		{#snippet columns({ Column })}
			<Column name="job_title" />
			<Column name="job_number" />
			<Column
				name="project_id"
				label={t('component.project')}
				minWidth={200}
				render={({ value }) =>
					value == null || value === '' ? '—' : (projectLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="job_type" />
			<Column name="status" />
			<Column name="priority" />
			<Column name="schedule_range" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.construction_settings_workforce.eyebrow')}
		title={t('app.construction_settings_workforce.header_title')}
		description={t('app.construction_settings_workforce.header_description')}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{
				name: 'workers',
				label: t('app.construction_settings_workforce.tab_workers'),
				icon: 'lucide:users',
				content: workers
			},
			{
				name: 'certifications',
				label: t('app.construction_settings_workforce.tab_certifications'),
				icon: 'lucide:badge-check',
				content: certifications
			},
			{
				name: 'job-requirements',
				label: t('app.construction_settings_workforce.tab_job_requirements'),
				icon: 'lucide:briefcase',
				content: jobRequirements
			}
		] satisfies TabConfig[]}
	/>
</Cover>
