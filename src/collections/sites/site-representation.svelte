<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { Row } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { calendarDateInTimeZone } from '../../lib/calendar.js';

	let { record }: { record: Row } = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const recordId = $derived(record.norbital_id);
	const today = calendarDateInTimeZone(new Date());
	const siteJobsQuery = $derived(
		client.db.jobs.findMany({
			where: { site_id: { eq: recordId } },
			limit: 500
		})
	);
	const siteJobs = $derived(siteJobsQuery.current ?? []);
	const upcomingJobIds = $derived(
		siteJobs
			.filter((job) => {
				const jobDate = calendarDateInTimeZone(new Date(job.scheduled_for));
				return (
					jobDate >= today ||
					(jobDate < today && (job.status === 'unassigned' || job.status === 'assigned'))
				);
			})
			.map((job) => job.norbital_id)
	);
	const historicalJobIds = $derived(
		siteJobs
			.filter((job) => job.status === 'in_progress' || job.status === 'completed')
			.map((job) => job.norbital_id)
	);
	const jobById = $derived(new Map(siteJobs.map((job) => [job.norbital_id, job] as const)));
</script>

{#snippet generalInformation()}
	<CollectionForm {client} collection="sites" {recordId} defaultValues={record}>
		{#snippet children({ Field })}
			<Stack gap="md">
				<div>
					<h3 id="site-general-heading" class="text-sm font-semibold">
						{t('component.general_information')}
					</h3>
					<p class="text-sm text-muted-foreground">
						{t('component.general_information_description')}
					</p>
				</div>
				<Grid minimum="panel">
					<Field name="name" />
					<Field name="client_name" label={t('component.client_tenant')} />
					<Field name="house_type" label={t('component.site_type')} />
					<Field name="floor_area_sqm" label={t('component.floor_area_sqm')} />
					<Column span="all"><Field name="location" /></Column>
				</Grid>
			</Stack>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet upcomingJobs()}
	<CollectionTable
		{client}
		collection="jobs"
		view={`field_ops_site:${recordId}:upcoming`}
		title={t('component.upcoming_scheduled_jobs')}
		description={t('component.upcoming_scheduled_jobs_description')}
		query={{
			where: { norbital_id: { in: upcomingJobIds } },
			orderBy: { scheduled_for: 'asc' }
		}}
		searchPlaceholder={t('component.search_upcoming_jobs')}
	>
		{#snippet columns({ Column })}
			<Column name="title" minWidth={240} card="title" />
			<Column name="scheduled_for" label={t('component.scheduled')} card="badge" />
			<Column name="status" />
			<Column name="nature" label={t('component.job_nature')} minWidth={180} />
			<Column name="description" card="subtitle" minWidth={200} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet activityHistory()}
	<CollectionTable
		{client}
		collection="job_assignments"
		view={`field_ops_site:${recordId}:history`}
		title={t('component.activity_history')}
		description={t('component.activity_history_description')}
		query={{
			where: { job_id: { in: historicalJobIds } },
			orderBy: { dispatched_at: 'desc' }
		}}
	>
		{#snippet columns({ Column })}
			<Column
				name="job_id"
				label={t('component.job_site_date')}
				minWidth={360}
				card="title"
				render={({ row }) => {
					const job = jobById.get(row.job_id);
					return job ? `${job.title} · ${record.name} · ${job.scheduled_for}` : t('component.job');
				}}
			/>
			<Column name="dispatched_at" label={t('component.dispatched')} />
			<Column name="status" card="badge" />
			<Column name="completed_at" label={t('component.completed')} />
			<Column name="amount_charged" label={t('component.value_charged')} />
			<Column name="location" label={t('component.reported_location')} minWidth={220} />
			<Column name="summary" card="subtitle" minWidth={200} />
		{/snippet}
	</CollectionTable>
{/snippet}

<Tabs
	lazyLoad={false}
	animate={false}
	config={[
		{
			name: 'general',
			label: t('component.general_information'),
			icon: 'lucide:building',
			content: generalInformation
		},
		{
			name: 'upcoming',
			label: t('component.upcoming_jobs'),
			icon: 'lucide:calendar-clock',
			content: upcomingJobs
		},
		{
			name: 'history',
			label: t('component.activity_history'),
			icon: 'lucide:history',
			content: activityHistory
		}
	] satisfies TabConfig[]}
/>
