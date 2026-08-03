<script lang="ts">
	import { client } from '$pod/client';
	import { getPlatformStateContext } from '@norbital-ai/pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';

	const user = getPlatformStateContext()().user;
	const contractorQuery = client.db.contractor_profiles.findMany({
		where: { user_id: { eq: user.norbital_id } },
		limit: 1
	});
	const contractor = $derived(contractorQuery.current?.[0]);
	const jobsQuery = client.db.jobs.findMany({
		orderBy: { scheduled_for: 'desc' },
		limit: 250
	});
	const sitesQuery = client.db.sites.findMany({ orderBy: { name: 'asc' }, limit: 250 });
	const siteById = $derived(
		new Map((sitesQuery.current ?? []).map((site) => [site.norbital_id, site.name]))
	);
	const jobById = $derived(new Map((jobsQuery.current ?? []).map((job) => [job.norbital_id, job])));
</script>

<svelte:head>
	<title>Contractor Workspace</title>
	<meta name="description" content="Update dispatched day jobs" />
	<meta name="pod:icon" content="lucide:hard-hat" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Contractor workspace"
		title={contractor?.company_name ?? 'Contractor jobs'}
		description="Review dispatched work, site details, and report progress from the field."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Bound size="full" inset>
		{#if contractorQuery.error}
			<p class="text-sm text-destructive">Could not load your contractor profile.</p>
		{:else if contractorQuery.loading}
			<div class="h-48 rounded-md bg-muted/50 motion-safe:animate-pulse" aria-label="Loading"></div>
		{:else}
			<CollectionTable
				{client}
				collection="job_assignments"
				title="Dispatched jobs"
				description="Jobs visible under your access policy. Review the site and scope, update progress, and inspect information captured by agents."
				query={{ orderBy: { dispatched_at: 'desc' } }}
			>
				{#snippet columns({ Column })}
					<Column
						name="job_id"
						label="Job · site · date"
						minWidth={360}
						card="title"
						render={({ row }) => {
							const job = jobById.get(row.job_id);
							return job
								? `${job.title} · ${siteById.get(job.site_id) ?? 'Unknown site'} · ${job.scheduled_for}`
								: 'Job';
						}}
					/>
					<Column name="dispatched_at" label="Dispatched" />
					<Column name="status" card="badge" />
					<Column name="location" label="Reported location" minWidth={220} />
					<Column name="summary" card="subtitle" minWidth={200} />
				{/snippet}
			</CollectionTable>
		{/if}
	</Bound>
</Cover>
