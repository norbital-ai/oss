<script lang="ts">
	import { client } from '$pod/client';
	import { getPlatformStateContext } from '@norbital-ai/pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';

	const { t } = useI18n<TenantI18nKeys>();

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
		eyebrow={t('app.field_ops_contractor.eyebrow')}
		title={contractor?.company_name ?? t('app.field_ops_contractor.header_title')}
		description={t('app.field_ops_contractor.header_description')}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Bound size="full" inset>
		{#if contractorQuery.error}
			<p class="text-sm text-destructive">
				{t('app.field_ops_contractor.profile_load_failed')}
			</p>
		{:else if contractorQuery.loading}
			<div class="h-48 rounded-md bg-muted/50 motion-safe:animate-pulse" aria-label="Loading"></div>
		{:else}
			<CollectionTable
				{client}
				collection="job_assignments"
				title={t('app.field_ops_contractor.dispatched_jobs')}
				description={t('app.field_ops_contractor.dispatched_jobs_description')}
				query={{ orderBy: { dispatched_at: 'desc' } }}
			>
				{#snippet columns({ Column })}
					<Column
						name="job_id"
						label={t('component.job_site_date')}
						minWidth={360}
						card="title"
						render={({ row }) => {
							const job = jobById.get(row.job_id);
							return job
								? `${job.title} · ${siteById.get(job.site_id) ?? '—'} · ${job.scheduled_for}`
								: t('component.job');
						}}
					/>
					<Column name="dispatched_at" label={t('component.dispatched')} />
					<Column name="status" card="badge" />
					<Column name="location" label={t('component.reported_location')} minWidth={220} />
					<Column name="summary" card="subtitle" minWidth={200} />
				{/snippet}
			</CollectionTable>
		{/if}
	</Bound>
</Cover>
