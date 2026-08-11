<script lang="ts">
	import { client } from '$pod/client';
	import { getPlatformStateContext } from '@norbital-ai/pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound } from '@norbital-ai/ui/layout';

	const { t } = useI18n<TenantI18nKeys>();

	const user = getPlatformStateContext()().user;
	const contractorQuery = client.db.contractor_profiles.findMany({
		where: { user_id: { eq: user.norbital_id } },
		limit: 1
	});
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
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/field-operations/app-media/field_ops_contractor-banner.webp"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/field-operations/app-media/field_ops_contractor-banner.webp"
	/>
</svelte:head>

<!-- App identity (title/description/icon) is rendered by the shell AppMediaHeader. -->
<Bound as="main" size="full" inset>
	{#if contractorQuery.error}
		<p class="text-sm text-destructive">
			{t('app.field_ops_contractor.profile_load_failed')}
		</p>
	{:else if contractorQuery.loading}
		<div
			class="h-48 rounded-md bg-muted/50 motion-safe:animate-pulse"
			aria-label={t('component.loading')}
		></div>
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
				<Column
					name="status"
					card="badge"
					render={({ row, value }) => {
						// The contractor sees their assignment's progress, never the controller-only
						// integrity overlay: a `suspect` row reads as the linked job's own progression,
						// which the assignment hooks keep in lockstep for every non-flagged path.
						if (value === 'suspect') {
							const job = jobById.get(row.job_id);
							switch (job?.status) {
								case 'assigned':
									return t('component.status_assigned');
								case 'in_progress':
									return t('component.status_in_progress');
								case 'completed':
									return t('component.status_completed');
								default:
									return '—';
							}
						}
						return typeof value === 'string' ? value : '—';
					}}
				/>
				<Column name="location" label={t('component.reported_location')} minWidth={220} />
				<Column name="summary" card="subtitle" minWidth={200} />
			{/snippet}
		</CollectionTable>
	{/if}
</Bound>
