<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { calendarDateInTimeZone } from '../../lib/calendar.js';

	let { record }: { record: Row } = $props();
	const recordId = $derived(record.norbital_id);
	const today = calendarDateInTimeZone(new Date(), 'Asia/Singapore');
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
				const jobDate = calendarDateInTimeZone(new Date(job.scheduled_for), 'Asia/Singapore');
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
					<h3 id="site-general-heading" class="text-sm font-semibold">General information</h3>
					<p class="text-sm text-muted-foreground">
						Client context and the exact location used for dispatch mapping.
					</p>
				</div>
				<Grid minimum="panel">
					<Field name="name" />
					<Field name="client_name" label="Client / tenant" />
					<Field name="house_type" label="Site type" />
					<Field name="floor_area_sqm" label="Floor area (sqm)" />
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
		title="Upcoming scheduled jobs"
		description="Future-dated jobs and past-due jobs that are still pending assignment or dispatch. New jobs open the job form — pick this site on the form."
		query={{
			where: { norbital_id: { in: upcomingJobIds } },
			orderBy: { scheduled_for: 'asc' }
		}}
		searchPlaceholder="Search upcoming jobs…"
	>
		{#snippet columns({ Column })}
			<Column name="title" minWidth={240} card="title" />
			<Column name="scheduled_for" label="Scheduled" card="badge" />
			<Column name="status" />
			<Column name="nature" label="Job nature" minWidth={180} />
			<Column name="description" card="subtitle" minWidth={200} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet activityHistory()}
	<CollectionTable
		{client}
		collection="job_assignments"
		view={`field_ops_site:${recordId}:history`}
		title="Activity history"
		description="Jobs that have progressed past dispatch — work in progress or completed."
		query={{
			where: { job_id: { in: historicalJobIds } },
			orderBy: { dispatched_at: 'desc' }
		}}
	>
		{#snippet columns({ Column })}
			<Column
				name="job_id"
				label="Job · site · date"
				minWidth={360}
				card="title"
				render={({ row }) => {
					const job = jobById.get(row.job_id);
					return job ? `${job.title} · ${record.name} · ${job.scheduled_for}` : 'Job';
				}}
			/>
			<Column name="dispatched_at" label="Dispatched" />
			<Column name="status" card="badge" />
			<Column name="completed_at" label="Completed" />
			<Column name="amount_charged" label="Value charged" />
			<Column name="location" label="Reported location" minWidth={220} />
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
			label: 'General information',
			icon: 'lucide:building',
			content: generalInformation
		},
		{
			name: 'upcoming',
			label: 'Upcoming jobs',
			icon: 'lucide:calendar-clock',
			content: upcomingJobs
		},
		{
			name: 'history',
			label: 'Activity history',
			icon: 'lucide:history',
			content: activityHistory
		}
	] satisfies TabConfig[]}
/>
