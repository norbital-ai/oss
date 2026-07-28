<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { client } from '$pod/client';
</script>

<svelte:head>
	<title>Construction Project Workspace</title>
	<meta name="description" content="Manage construction delivery records." />
	<meta name="pod:icon" content="lucide:layout-dashboard" />
</svelte:head>

{#snippet projects()}
	<CollectionTable {client} collection="projects" query={{ limit: 50 }}>
		{#snippet columns({ Column })}
			<Column name="project_name" />
			<Column name="project_number" />
			<Column name="client" />
			<Column name="status" />
			<Column name="schedule_range" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet rfis()}
	<CollectionTable {client} collection="rfis">
		{#snippet columns({ Column })}
			<Column name="rfi_number" />
			<Column name="title" />
			<Column name="status" />
			<Column name="priority" />
			<Column name="assigned_to" />
			<Column name="due_date" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet defects()}
	<CollectionTable {client} collection="defects">
		{#snippet columns({ Column })}
			<Column name="defect_number" />
			<Column name="title" />
			<Column name="category" />
			<Column name="severity" />
			<Column name="status" />
			<Column name="due_date" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet paymentClaims()}
	<CollectionTable {client} collection="payment_claims">
		{#snippet columns({ Column })}
			<Column name="claim_number" />
			<Column name="claim_type" />
			<Column name="status" />
			<Column name="claimed_amount" />
			<Column name="certified_amount" />
			<Column name="submitted_date" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet bimReferences()}
	<CollectionTable {client} collection="bim_reference_matrix">
		{#snippet columns({ Column })}
			<Column name="reference_name" />
			<Column name="reference_code" />
			<Column name="category" />
			<Column name="unit_of_measure" />
			<Column name="rate" />
			<Column name="embodied_carbon_per_unit" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet jobAssignments()}
	<CollectionTable {client} collection="job_assignments">
		{#snippet columns({ Column })}
			<Column name="assignment_code" />
			<Column name="role" />
			<Column name="status" />
			<Column name="assignment_range" />
			<Column name="hours_per_day" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Construction"
		title="Project workspace"
		description="Coordinate models, delivery records, commercial controls, and site manpower."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{ name: 'projects', label: 'Projects', icon: 'lucide:building-2', content: projects },
			{ name: 'rfis', label: 'RFIs', icon: 'lucide:messages-square', content: rfis },
			{ name: 'defects', label: 'Defects', icon: 'lucide:triangle-alert', content: defects },
			{
				name: 'payment-claims',
				label: 'Payment claims',
				icon: 'lucide:banknote',
				content: paymentClaims
			},
			{
				name: 'bim-references',
				label: 'BIM references',
				icon: 'lucide:table-properties',
				content: bimReferences
			},
			{
				name: 'job-assignments',
				label: 'Job assignments',
				icon: 'lucide:hard-hat',
				content: jobAssignments
			}
		] satisfies TabConfig[]}
	/>
</Cover>
