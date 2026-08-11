<script lang="ts">
	import { client, type WorkspaceRow } from '$pod/client';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionKanban } from '@norbital-ai/ui/collection-kanban';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { DataRenderer } from '@norbital-ai/ui/data-renderer';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { Bound, Cluster, Cover, Inline, Split, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { StaticMap, type StaticMapMarker } from '@norbital-ai/ui/static-map';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { renderComponent } from '@norbital-ai/ui/utils';
	import Icon from '@iconify/svelte';
	import { calendarDateInTimeZone, shiftCalendarDate } from '../lib/calendar.js';
	import { contractorSatisfiesCertificationRequirements } from '../lib/certification-eligibility.js';

	type ContractorCertification = WorkspaceRow<'contractor_certifications'>;
	interface AssignmentForm {
		jobId: string | null;
		contractorId: string | null;
		saving: boolean;
		error: string | null;
	}

	const today = calendarDateInTimeZone(new Date());

	const { t } = useI18n<TenantI18nKeys>();

	let dispatchDay = $state(today);
	let assignContractorOpen = $state(false);
	const dashboardQuery = $derived(
		client.invoke.field_ops_dashboard({ scheduled_for: dispatchDay })
	);
	const assignmentCardById = $derived(
		new Map((dashboardQuery.current?.assignment_cards ?? []).map((card) => [card.id, card]))
	);
	// Reactive board query: when the dispatch day changes the dashboard refetches, the assignment
	// id list changes, and the kanban refetches automatically — no `{#key}` re-mount hack needed.
	const boardQuery = $derived({
		where: { norbital_id: { in: dashboardQuery.current?.assignment_ids ?? [] } },
		orderBy: { dispatched_at: 'asc' as const }
	});
	// View-level lane presentation: labels/colors live here, not on the model (pure data schema).
	const dispatchLanes = $derived([
		{ value: 'dispatched', label: t('component.status_dispatched'), color: 'blue' },
		{ value: 'in_progress', label: t('component.status_in_progress'), color: 'amber' },
		{ value: 'completed', label: t('component.status_completed'), color: 'green' },
		{ value: 'suspect', label: t('component.status_suspect'), color: 'red' }
	]);

	// Assign-contractor sheet — filters unassigned jobs for the day to certified contractors.
	const assignJobsQuery = $derived(
		client.db.jobs.findMany({
			where: { scheduled_for: { eq: dispatchDay }, status: { eq: 'unassigned' } },
			orderBy: { title: 'asc' },
			limit: 250
		})
	);
	const assignContractorsQuery = client.db.contractor_profiles.findMany({
		orderBy: { company_name: 'asc' },
		limit: 250
	});
	const sitesQuery = client.db.sites.findMany({
		orderBy: { name: 'asc' },
		limit: 250
	});
	const siteNameById = $derived(
		new Map((sitesQuery.current ?? []).map((site) => [site.norbital_id, site.name]))
	);
	let assignment = $state<AssignmentForm>({
		jobId: null,
		contractorId: null,
		saving: false,
		error: null
	});
	const assignSelectedJob = $derived(
		(assignJobsQuery.current ?? []).find((job) => job.norbital_id === assignment.jobId)
	);
	const assignRequirementsQuery = $derived(
		assignSelectedJob?.norbital_id
			? client.db.job_certification_requirements.findMany({
					where: { job_id: { eq: assignSelectedJob.norbital_id } },
					limit: 250
				})
			: null
	);
	const assignContractorIds = $derived(
		(assignContractorsQuery.current ?? []).map((contractor) => contractor.norbital_id)
	);
	const assignContractorCertificationQuery = $derived(
		assignContractorIds.length
			? client.db.contractor_certifications.findMany({
					where: { contractor_profile_id: { in: assignContractorIds } },
					limit: 500
				})
			: null
	);
	const assignContractorCertifications = $derived(
		assignContractorCertificationQuery?.current ?? []
	);
	const assignCertificationsByContractor = $derived(
		new Map<string, ContractorCertification[]>(
			[...new Set(assignContractorCertifications.map((link) => link.contractor_profile_id))].map(
				(contractorProfileId) => [
					contractorProfileId,
					assignContractorCertifications.filter(
						(link) => link.contractor_profile_id === contractorProfileId
					)
				]
			)
		)
	);
	const assignQualifiedContractors = $derived(
		(assignContractorsQuery.current ?? []).filter((contractor) =>
			contractorSatisfiesCertificationRequirements(
				assignCertificationsByContractor.get(contractor.norbital_id) ?? [],
				assignRequirementsQuery?.current ?? []
			)
		)
	);
	const assignJobOptions = $derived(
		(assignJobsQuery.current ?? []).map((job) => ({
			value: job.norbital_id,
			label: `${job.title} · ${siteNameById.get(job.site_id) ?? '—'}`
		}))
	);
	const assignContractorOptions = $derived(
		assignQualifiedContractors.map((contractor) => ({
			value: contractor.norbital_id,
			label: contractor.company_name
		}))
	);

	function setDispatchDay(next: string): void {
		dispatchDay = next;
	}

	function updateDispatchDate(value: unknown): void {
		if (typeof value === 'string') setDispatchDay(value);
	}

	async function refreshDispatch(): Promise<void> {
		await dashboardQuery.refresh();
	}

	async function createAssignment(): Promise<void> {
		if (!assignment.jobId || !assignment.contractorId || assignment.saving) return;
		assignment.saving = true;
		assignment.error = null;
		try {
			const create = client.db.job_assignments.create;
			if (!create) throw new Error(t('component.assignment_create_unavailable'));
			await create({
				job_id: assignment.jobId,
				contractor_profile_id: assignment.contractorId,
				status: 'dispatched',
				site_identity_unverified: true
			});
			assignment.jobId = null;
			assignment.contractorId = null;
			await refreshDispatch();
			assignContractorOpen = false;
		} catch (reason) {
			assignment.error =
				reason instanceof Error ? reason.message : t('component.assignment_create_failed');
		} finally {
			assignment.saving = false;
		}
	}

	const mapPoints = $derived(dashboardQuery.current?.map_points ?? []);
	const mapMarkers = $derived<StaticMapMarker[]>(
		mapPoints.map((point, index) => ({
			latitude: point.latitude,
			longitude: point.longitude,
			...(index < 26 ? { label: String.fromCharCode(65 + index) } : {}),
			ariaLabel: point.name,
			tone: point.assignments.some((assignment) => assignment.status === 'suspect')
				? 'alert'
				: 'default'
		}))
	);
</script>

{#snippet mapMarkerContent(_marker: StaticMapMarker, index: number)}
	{@const point = mapPoints[index]}
	{#if point}
		<!-- stupidity:allow UI10 -- the map marker popover is width-constrained by the map overlay, not by a primitive -->
		<Stack gap="sm" class="w-64">
			<Stack gap="none">
				<h3 class="text-sm font-medium">{point.name}</h3>
				<p class="text-xs text-muted-foreground">{point.label}</p>
			</Stack>
			<Stack as="ul" gap="xs" class="border-t border-border pt-3">
				{#each point.assignments as assignment (assignment.id)}
					<li class="text-xs">
						<p class="font-medium">{assignment.job}</p>
						<p class="text-muted-foreground">
							{assignment.contractor} · {assignment.status.replaceAll('_', ' ')}
						</p>
					</li>
				{/each}
			</Stack>
		</Stack>
	{/if}
{/snippet}

<svelte:head>
	<title>Field Operations Controller</title>
	<meta name="description" content="Schedule site jobs and dispatch qualified contractors" />
	<meta name="pod:icon" content="lucide:building-2" />
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/field-operations/app-media/field_ops_controller-banner.webp"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/field-operations/app-media/field_ops_controller-banner.webp"
	/>
</svelte:head>

{#snippet dispatchSchedule()}
	<Stack gap="md">
		<Split ratio="wide" collapse="stack" gap="md" class="rounded-lg border bg-card p-3">
			{#snippet start()}
				<Stack gap="xs" class="max-w-md">
					<Inline justify="between" gap="sm">
						<span class="text-xs font-medium text-muted-foreground">
							{t('app.field_ops_controller.dispatch_date')}
						</span>
						<Button
							variant="ghost"
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={() => setDispatchDay(today)}
						>
							{t('app.field_ops_controller.today')}
						</Button>
					</Inline>
					<Inline gap="xs">
						<Button
							variant="outline"
							size="icon"
							aria-label={t('app.field_ops_controller.previous_day')}
							hint={t('app.field_ops_controller.previous_day')}
							onclick={() => setDispatchDay(shiftCalendarDate(dispatchDay, -1))}
						>
							<Icon icon="lucide:chevron-left" class="size-4" />
						</Button>
						<div class="min-w-0">
							<DataRenderer
								field={{ name: 'dispatch_date', kind: 'date', nullable: false }}
								value={dispatchDay}
								mode="edit"
								placeholder={t('app.field_ops_controller.select_dispatch_date')}
								onValueChange={updateDispatchDate}
							/>
						</div>
						<Button
							variant="outline"
							size="icon"
							aria-label={t('app.field_ops_controller.next_day')}
							hint={t('app.field_ops_controller.next_day')}
							onclick={() => setDispatchDay(shiftCalendarDate(dispatchDay, 1))}
						>
							<Icon icon="lucide:chevron-right" class="size-4" />
						</Button>
					</Inline>
				</Stack>
			{/snippet}
			{#snippet end()}
				<Cluster gap="sm" justify="end">
					<Button variant="secondary" onclick={() => (assignContractorOpen = true)}>
						<Icon icon="lucide:user-round-check" class="mr-1.5 size-4 shrink-0" />
						{t('app.field_ops_controller.assign_contractor')}
					</Button>
				</Cluster>
			{/snippet}
		</Split>

		<Split
			ratio="wide"
			collapse="switch"
			switchLabels={[t('app.field_ops_controller.board'), t('app.field_ops_controller.map')]}
			gap="md"
		>
			{#snippet start()}
				<Bound size="fit" pad="sm" class="rounded-lg border bg-card">
					<CollectionKanban
						{client}
						collection="job_assignments"
						groupBy="status"
						lanes={dispatchLanes}
						rows={2}
						query={boardQuery}
					>
						{#snippet Card(assignment)}
							<Stack gap="xs">
								<p class="text-sm font-medium">
									{assignmentCardById.get(assignment.norbital_id)?.job ??
										t('component.job_assignment')}
								</p>
								<p class="text-xs text-muted-foreground">
									{assignmentCardById.get(assignment.norbital_id)?.contractor ??
										t('component.contractor')}
								</p>
							</Stack>
						{/snippet}
					</CollectionKanban>
				</Bound>
			{/snippet}
			{#snippet end()}
				<Bound size="fit" clip class="rounded-lg">
					<StaticMap
						markers={mapMarkers}
						ariaLabel={t('app.field_ops_controller.dispatch_map_for', { date: dispatchDay })}
						emptyDescription={t('app.field_ops_controller.map_empty', { date: dispatchDay })}
						class="size-full"
						markerContent={mapMarkerContent}
					/>
				</Bound>
			{/snippet}
		</Split>
	</Stack>
{/snippet}

{#snippet sites()}
	<CollectionTable
		{client}
		collection="sites"
		title={t('app.field_ops_controller.tab_sites')}
		description={t('app.field_ops_controller.sites_description')}
		query={{ orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="name" minWidth={200} card="title" />
			<Column
				name="client_name"
				label={t('component.client_tenant')}
				minWidth={180}
				card="subtitle"
			/>
			<Column name="location" minWidth={260} />
			<Column name="house_type" label={t('component.site_type')} card="badge" />
			<Column name="floor_area_sqm" label={t('component.floor_area_sqm')} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet contractors()}
	<CollectionTable
		{client}
		collection="contractor_profiles"
		title={t('app.field_ops_controller.tab_contractors')}
		description={t('app.field_ops_controller.contractors_description')}
		query={{ orderBy: { company_name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="company_name" minWidth={240} card="title" />
			<Column
				name="user_id"
				label={t('component.portal_user')}
				minWidth={240}
				card="subtitle"
				render={({ value }) =>
					renderComponent(RelationshipRenderer, {
						target: 'user',
						value: typeof value === 'string' ? value : null,
						options: {
							label: (record) => {
								const v = record.name;
								return v != null && v !== '' ? String(v) : '—';
							},
							orderBy: { name: 'asc' },
							limit: 500
						},
						displayOnly: true
					})}
			/>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet certifications()}
	<CollectionTable
		{client}
		collection="certification_types"
		title={t('app.field_ops_controller.certification_catalogue')}
		description={t('app.field_ops_controller.certifications_description')}
		query={{ orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={140} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="category" minWidth={160} card="subtitle" />
			<Column name="issuing_body" label={t('component.issuing_body')} minWidth={200} />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

<Cover as="main">
	<Tabs
		animate={false}
		config={[
			{
				name: 'dispatch',
				label: t('app.field_ops_controller.tab_dispatch'),
				icon: 'lucide:kanban',
				content: dispatchSchedule
			},
			{
				name: 'sites',
				label: t('app.field_ops_controller.tab_sites'),
				icon: 'lucide:map-pinned',
				content: sites
			},
			{
				name: 'contractors',
				label: t('app.field_ops_controller.tab_contractors'),
				icon: 'lucide:hard-hat',
				content: contractors
			},
			{
				name: 'certifications',
				label: t('app.field_ops_controller.tab_certifications'),
				icon: 'lucide:badge-check',
				content: certifications
			}
		] satisfies TabConfig[]}
	/>
</Cover>

<Sheet.Root bind:open={assignContractorOpen}>
	<Sheet.Content flush class="sm:max-w-lg">
		<Sheet.Header class="border-b border-border px-5 py-4">
			<Sheet.Title>{t('app.field_ops_controller.sheet_title')}</Sheet.Title>
			<Sheet.Description>
				{t('app.field_ops_controller.sheet_description', { date: dispatchDay })}
			</Sheet.Description>
		</Sheet.Header>
		<Stack
			as="form"
			gap="md"
			class="p-5"
			onsubmit={(event) => {
				event.preventDefault();
				void createAssignment();
			}}
		>
			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">{t('app.field_ops_controller.job_and_site')}</span>
				<Combobox
					options={assignJobOptions}
					bind:value={assignment.jobId}
					emptyPlaceholder={t('app.field_ops_controller.select_unassigned_job')}
					searchPlaceholder={t('app.field_ops_controller.search_unassigned_jobs')}
					clientConfig={{
						isLoading: assignJobsQuery.loading,
						error: assignJobsQuery.error?.message ?? null
					}}
				/>
			</label>

			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">{t('component.contractor')}</span>
				<Combobox
					options={assignContractorOptions}
					bind:value={assignment.contractorId}
					emptyPlaceholder={t('app.field_ops_controller.select_qualified_contractor')}
					searchPlaceholder={t('app.field_ops_controller.search_qualified_contractors')}
					clientConfig={{
						isLoading:
							assignContractorsQuery.loading ||
							Boolean(assignRequirementsQuery?.loading) ||
							Boolean(assignContractorCertificationQuery?.loading),
						error: assignContractorsQuery.error?.message ?? null
					}}
					disabled={!assignSelectedJob}
				/>
			</label>

			{#if assignSelectedJob && assignQualifiedContractors.length === 0}
				<p class="text-sm text-destructive" role="alert">
					{t('app.field_ops_controller.no_qualified_contractor')}
				</p>
			{/if}
			{#if assignment.error}
				<p class="text-sm text-destructive" role="alert">{assignment.error}</p>
			{/if}
			{#if (assignJobsQuery.current ?? []).length === 0 && !assignJobsQuery.loading}
				<p class="text-sm text-muted-foreground">
					{t('app.field_ops_controller.no_unassigned_jobs', { date: dispatchDay })}
				</p>
			{/if}

			<Button
				type="submit"
				class="w-full"
				disabled={!assignment.jobId || !assignment.contractorId || assignment.saving}
			>
				{assignment.saving
					? t('app.field_ops_controller.assigning')
					: t('app.field_ops_controller.assign_contractor')}
			</Button>
		</Stack>
	</Sheet.Content>
</Sheet.Root>
