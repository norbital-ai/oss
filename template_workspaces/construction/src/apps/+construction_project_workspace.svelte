<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
</script>

<svelte:head>
	<title>Construction Project Workspace</title>
	<meta name="description" content="Browse construction projects and open project records." />
	<meta name="pod:icon" content="lucide:layout-dashboard" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Construction"
		title="Project workspace"
		description="Browse the project catalogue. Open a project record to manage RFIs, defects, claims, and manpower."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<CollectionTable {client} collection="projects" query={{ limit: 50 }}>
		{#snippet columns({ Column })}
			<Column name="project_name" />
			<Column name="project_number" />
			<Column name="client" />
			<Column name="status" />
			<Column name="schedule_range" />
		{/snippet}
	</CollectionTable>
</Cover>
