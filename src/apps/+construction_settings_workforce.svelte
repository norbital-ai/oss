<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { client } from '$pod/client';
</script>

<svelte:head>
	<title>Construction Workforce Settings</title>
	<meta name="description" content="Manage workers, certifications, and job requirements." />
	<meta name="pod:icon" content="lucide:users" />
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
	<CollectionTable {client} collection="jobs">
		{#snippet columns({ Column })}
			<Column name="job_title" />
			<Column name="job_number" />
			<Column name="job_type" />
			<Column name="status" />
			<Column name="priority" />
			<Column name="schedule_range" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Construction settings"
		title="Workforce Settings"
		description="Manage workers, certifications, and job requirements."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{ name: 'workers', label: 'Workers', icon: 'lucide:users', content: workers },
			{
				name: 'certifications',
				label: 'Certifications',
				icon: 'lucide:badge-check',
				content: certifications
			},
			{
				name: 'job-requirements',
				label: 'Job requirements',
				icon: 'lucide:briefcase',
				content: jobRequirements
			}
		] satisfies TabConfig[]}
	/>
</Cover>
