<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import {
		Bound,
		Cluster,
		Columns,
		Cover,
		Grid,
		Inline,
		Scroll,
		Split,
		Stack
	} from '@norbital-ai/ui/layout';
	import { formatDateRangeLocal } from '@norbital-ai/std/date';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import IfcDisplay from '../../lib/ifc-viewer/ifc_display.svelte';

	interface MoneyValue {
		value: number;
		currency: string;
	}

	function todayKey(): string {
		return new Date().toISOString().slice(0, 10);
	}

	let { record }: { record: Row } = $props();

	const projectId = $derived(record.norbital_id);
	const today = todayKey();

	const sitesQuery = $derived(
		client.db.site_locations.findMany({
			where: { project_id: { eq: projectId } },
			orderBy: { location_name: 'asc' },
			limit: 100
		})
	);
	const siteIds = $derived((sitesQuery.current ?? []).map((site) => site.norbital_id));

	const assignmentsQuery = $derived(
		siteIds.length === 0
			? null
			: client.db.job_assignments.findMany({
					where: { site_location_id: { in: siteIds } },
					orderBy: { norbital_updated_at: 'desc' },
					limit: 500
				})
	);

	const claimsQuery = $derived(
		client.db.payment_claims.findMany({
			where: { project_id: { eq: projectId } },
			orderBy: { norbital_updated_at: 'desc' },
			limit: 100
		})
	);

	const documentsQuery = $derived(
		client.db.asset_documents.findMany({
			where: {
				project_id: { eq: projectId },
				status: { in: ['draft', 'in_review', 'issued'] }
			},
			orderBy: { norbital_updated_at: 'desc' },
			limit: 100
		})
	);

	const assignments = $derived(assignmentsQuery?.current ?? []);
	const workerIds = $derived([
		...new Set(
			assignments.flatMap((assignment) => (assignment.worker_id ? [assignment.worker_id] : []))
		)
	]);
	const jobIds = $derived([
		...new Set(assignments.flatMap((assignment) => (assignment.job_id ? [assignment.job_id] : [])))
	]);

	const workersQuery = $derived(
		workerIds.length === 0
			? null
			: client.db.workers.findMany({ where: { norbital_id: { in: workerIds } }, limit: 500 })
	);
	const jobsQuery = $derived(
		jobIds.length === 0
			? null
			: client.db.jobs.findMany({ where: { norbital_id: { in: jobIds } }, limit: 500 })
	);

	const workerById = $derived(
		new Map((workersQuery?.current ?? []).map((worker) => [worker.norbital_id, worker]))
	);
	const jobById = $derived(
		new Map((jobsQuery?.current ?? []).map((job) => [job.norbital_id, job]))
	);
	const claims = $derived(claimsQuery.current ?? []);
	const documents = $derived(documentsQuery.current ?? []);
	const ifcDocument = $derived(
		documents.find(
			(document) =>
				document.document_type === 'ifc_model' ||
				document.document_url?.toLowerCase().endsWith('.ifc')
		)
	);
	const loading = $derived(
		sitesQuery.loading ||
			Boolean(assignmentsQuery?.loading) ||
			Boolean(workersQuery?.loading) ||
			Boolean(jobsQuery?.loading) ||
			claimsQuery.loading ||
			documentsQuery.loading
	);
	const loadError = $derived(
		sitesQuery.error ??
			assignmentsQuery?.error ??
			workersQuery?.error ??
			jobsQuery?.error ??
			claimsQuery.error ??
			documentsQuery.error
	);

	function formatDate(value: Date | string | null | undefined): string {
		if (!value) return 'Not set';
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
			new Date(value)
		);
	}

	function formatMoney(value: MoneyValue | null | undefined): string {
		if (!value) return 'Not set';
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: value.currency,
			maximumFractionDigits: 0
		}).format(value.value);
	}

	function sumMoney(values: readonly (MoneyValue | null | undefined)[]): string {
		const totals = new Map<string, number>();
		for (const value of values) {
			if (!value) continue;
			totals.set(value.currency, (totals.get(value.currency) ?? 0) + value.value);
		}
		if (totals.size === 0) return 'No value';
		return [...totals.entries()]
			.map(([currency, value]) => formatMoney({ currency, value }))
			.join(' · ');
	}
</script>

{#snippet projectSummary()}
	<Stack as="header" gap="md" class="border-b pb-5" aria-label="Project summary">
		<Cluster align="start" justify="between" gap="sm">
			<p class="min-w-0 text-sm text-muted-foreground">
				{record.project_number ?? 'No project number'} · {record.client ?? 'No client'}
			</p>
			<span class="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize">
				{record.status ?? 'Status not set'}
			</span>
		</Cluster>
		<Grid minimum="compact" class="text-sm">
			<div>
				<p class="text-xs text-muted-foreground">Programme</p>
				<p class="mt-1 font-medium">
					{record.schedule_range ? formatDateRangeLocal(record.schedule_range) : 'Not set'}
				</p>
			</div>
			<div>
				<p class="text-xs text-muted-foreground">Contract value</p>
				<p class="mt-1 font-medium">{formatMoney(record.contract_value)}</p>
			</div>
			<div>
				<p class="text-xs text-muted-foreground">Main contractor</p>
				<p class="mt-1 font-medium">{record.main_contractor ?? 'Not set'}</p>
			</div>
			<div>
				<p class="text-xs text-muted-foreground">Project manager</p>
				<p class="mt-1 font-medium">{record.project_manager ?? 'Not set'}</p>
			</div>
		</Grid>
	</Stack>

	{#if loadError}
		<p
			class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
		>
			{loadError.message}
		</p>
	{/if}
{/snippet}

{#snippet coordinationModel()}
	<Stack gap="sm">
		<div>
			<h3 class="text-heading">Coordination model</h3>
			<p class="max-w-[70ch] text-sm text-muted-foreground">
				Review the issued IFC model beside the live coordination register.
			</p>
		</div>
		{#if ifcDocument?.document_url}
			<Bound size="standard" clip class="rounded-md border bg-muted/30">
				<IfcDisplay src={ifcDocument.document_url} alt={ifcDocument.title ?? 'Current IFC model'} />
			</Bound>
		{:else if documentsQuery.loading}
			<div class="h-64 animate-pulse rounded-md bg-muted/60"></div>
		{:else}
			<Inline
				align="center"
				justify="center"
				class="h-64 rounded-md border border-dashed bg-muted/20 px-6 text-center text-sm text-muted-foreground"
			>
				Link an IFC document to this project to open the coordination model here.
			</Inline>
		{/if}
	</Stack>
{/snippet}
{#snippet deliveryPulse()}
	<Stack as="aside" gap="md" class="border-t pt-4">
		<Stack gap="md">
			<p class="text-tiny uppercase tracking-wide text-muted-foreground">Delivery pulse</p>
			<dl class="divide-y text-sm">
				<Inline as="div" justify="between" class="py-2">
					<dt>Work fronts</dt>
					<dd class="font-medium tabular-nums">{sitesQuery.current?.length ?? 0}</dd>
				</Inline>
				<Inline as="div" justify="between" class="py-2">
					<dt>Allocated workers</dt>
					<dd class="font-medium tabular-nums">{assignments.length}</dd>
				</Inline>
				<Inline as="div" justify="between" class="py-2">
					<dt>Project documents</dt>
					<dd class="font-medium tabular-nums">{documents.length}</dd>
				</Inline>
			</dl>
		</Stack>
		{#if record.description}
			<Stack gap="sm">
				<p class="text-tiny uppercase tracking-wide text-muted-foreground">Scope</p>
				<p class="text-sm leading-normal">{record.description}</p>
			</Stack>
		{/if}
	</Stack>
{/snippet}

{#snippet coordination()}
	<Scroll name="Project model and coordination">
		<Stack gap="lg">
			<Split ratio="wide" collapse="stack" start={coordinationModel} end={deliveryPulse} />

			<Grid minimum="panel">
				<CollectionTable
					{client}
					collection="rfis"
					query={{ where: { project_id: { eq: projectId } }, limit: 25 }}
					title="RFIs"
					description="Design questions tied to this project."
				>
					{#snippet columns({ Column })}
						<Column name="rfi_number" label="RFI" />
						<Column name="title" minWidth={180} />
						<Column name="priority" />
						<Column name="status" />
						<Column name="due_date" label="Due" />
					{/snippet}
					{#snippet ListCard(rfi)}
						<Inline align="start" justify="between" gap="sm">
							<p class="truncate font-medium">{rfi.title}</p>
							<span class="shrink-0 text-xs text-muted-foreground">{rfi.status}</span>
						</Inline>
						<p class="mt-1 truncate text-sm text-muted-foreground">
							{rfi.rfi_number} · {rfi.priority}
						</p>
					{/snippet}
				</CollectionTable>
				<CollectionTable
					{client}
					collection="defects"
					query={{ where: { project_id: { eq: projectId } }, limit: 25 }}
					title="Defects"
					description="Quality issues across project work fronts."
				>
					{#snippet columns({ Column })}
						<Column name="defect_number" label="Defect" />
						<Column name="title" minWidth={180} />
						<Column name="severity" />
						<Column name="status" />
						<Column name="due_date" label="Due" />
					{/snippet}
					{#snippet ListCard(defect)}
						<Inline align="start" justify="between" gap="sm">
							<p class="truncate font-medium">{defect.title}</p>
							<span class="shrink-0 text-xs text-muted-foreground">{defect.status}</span>
						</Inline>
						<p class="mt-1 truncate text-sm text-muted-foreground">
							{defect.defect_number} · {defect.severity}
						</p>
					{/snippet}
				</CollectionTable>
			</Grid>
		</Stack>
	</Scroll>
{/snippet}

{#snippet manpower()}
	<Scroll name="Project manpower allocation">
		<Stack gap="lg">
			<Stack gap="xs">
				<h3 class="text-heading">Manpower allocation</h3>
				<p class="max-w-[70ch] text-sm text-muted-foreground">
					Each lane is a project work front. Cards show the worker, work package, role, and planned
					daily hours.
				</p>
			</Stack>
			{#if sitesQuery.loading || Boolean(assignmentsQuery?.loading)}
				<Columns count={3}>
					{#each [1, 2, 3] as lane (lane)}
						<div class="h-64 animate-pulse rounded-md bg-muted/60"></div>
					{/each}
				</Columns>
			{:else if (sitesQuery.current?.length ?? 0) === 0}
				<div
					class="rounded-md border border-dashed px-6 py-12 text-center text-sm text-muted-foreground"
				>
					Add a site location before allocating manpower.
				</div>
			{:else}
				<Bound size="standard" clip>
					<Scroll axis="x" name="Manpower allocation" class="pb-2">
						<Inline align="start" gap="md">
							{#each sitesQuery.current ?? [] as site (site.norbital_id)}
								{@const siteAssignments = assignments.filter(
									(assignment) => assignment.site_location_id === site.norbital_id
								)}
								<section class="w-72 shrink-0 rounded-md bg-muted/50 p-3">
									<Inline
										as="header"
										align="start"
										justify="between"
										gap="sm"
										class="border-b pb-3"
									>
										<div class="min-w-0">
											<h4 class="truncate text-sm font-medium">{site.location_name}</h4>
											<p class="mt-0.5 truncate text-xs text-muted-foreground">
												{site.location_code ?? site.location_type ?? 'Work front'}
											</p>
										</div>
										<span class="rounded-full bg-background px-2 py-0.5 text-xs tabular-nums">
											{siteAssignments.length}
										</span>
									</Inline>
									<Stack gap="sm" class="mt-3">
										{#each siteAssignments as assignment (assignment.norbital_id)}
											<article class="rounded-md border bg-card p-3 shadow-xs">
												<p class="text-sm font-medium">
													{assignment.worker_id
														? (workerById.get(assignment.worker_id)?.worker_name ?? '—')
														: '—'}
												</p>
												<p class="mt-1 text-xs text-muted-foreground">
													{assignment.job_id
														? (jobById.get(assignment.job_id)?.job_title ?? '—')
														: '—'}
												</p>
												<Inline justify="between" gap="sm" class="mt-3 text-xs">
													<span
														>{assignment.role ??
															(assignment.worker_id
																? workerById.get(assignment.worker_id)?.trade
																: null) ??
															'Site role'}</span
													>
													<span class="text-muted-foreground tabular-nums"
														>{assignment.hours_per_day ?? 0} h/day</span
													>
												</Inline>
											</article>
										{/each}
										{#if siteAssignments.length === 0}
											<p class="py-6 text-center text-xs text-muted-foreground">No allocations</p>
										{/if}
									</Stack>
								</section>
							{/each}
						</Inline>
					</Scroll>
				</Bound>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet controls()}
	<Scroll name="Project commercial controls">
		<Stack gap="lg">
			<Grid minimum="compact">
				<div class="border-b pb-3">
					<p class="text-xs text-muted-foreground">Contract value</p>
					<p class="mt-1 text-heading">{formatMoney(record.contract_value)}</p>
				</div>
				<div class="border-b pb-3">
					<p class="text-xs text-muted-foreground">Claimed</p>
					<p class="mt-1 text-heading">
						{sumMoney(claims.map((claim) => claim.claimed_amount))}
					</p>
				</div>
				<div class="border-b pb-3">
					<p class="text-xs text-muted-foreground">Certified</p>
					<p class="mt-1 text-heading">
						{sumMoney(claims.map((claim) => claim.certified_amount))}
					</p>
				</div>
				<div class="border-b pb-3">
					<p class="text-xs text-muted-foreground">Documents</p>
					<p class="mt-1 text-heading tabular-nums">{documents.length}</p>
				</div>
			</Grid>

			<Grid minimum="panel">
				<Stack as="section" gap="sm">
					<div class="border-b pb-2">
						<h3 class="text-sm font-semibold">Payment claims</h3>
						<p class="text-xs text-muted-foreground">Commercial progression for this project.</p>
					</div>
					<div class="divide-y rounded-md border bg-card">
						{#each claims as claim (claim.norbital_id)}
							<Inline align="start" justify="between" gap="md" class="p-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{claim.claim_number}</p>
									<p class="text-xs text-muted-foreground capitalize">
										{claim.claim_type ?? 'Progress claim'} · {claim.status ?? 'No status'}
									</p>
								</div>
								<p class="text-sm font-medium tabular-nums">{formatMoney(claim.claimed_amount)}</p>
							</Inline>
						{:else}
							<p class="p-4 text-sm text-muted-foreground">No payment claims.</p>
						{/each}
					</div>
				</Stack>

				<Stack as="section" gap="sm">
					<div class="border-b pb-2">
						<h3 class="text-sm font-semibold">Project documents</h3>
						<p class="text-xs text-muted-foreground">Models, handover packs, and asset records.</p>
					</div>
					<div class="divide-y rounded-md border bg-card">
						{#each documents as document (document.norbital_id)}
							<Inline align="start" justify="between" gap="md" class="p-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{document.title}</p>
									<p class="text-xs text-muted-foreground">
										{document.document_number ?? 'No document number'} · {document.version ??
											'No version'}
									</p>
								</div>
								{#if document.document_url}
									<a
										class="shrink-0 text-xs font-medium text-brand hover:underline"
										href={document.document_url}
										target="_blank"
										rel="noreferrer"
									>
										Open
									</a>
								{/if}
							</Inline>
						{:else}
							<p class="p-4 text-sm text-muted-foreground">No project documents.</p>
						{/each}
					</div>
				</Stack>
			</Grid>

			<CollectionTable
				{client}
				collection="permits_to_work"
				query={{
					where: {
						project_id: { eq: projectId },
						validity_range: { contains_date: today }
					},
					limit: 50
				}}
				title="Permits to work"
				description="Current work authority and expiry coverage."
			>
				{#snippet columns({ Column })}
					<Column name="permit_number" label="Permit" />
					<Column name="permit_type" label="Type" />
					<Column name="status" />
					<Column name="validity_range" label="Valid" />
					<Column name="approved_by" label="Approved by" />
				{/snippet}
				{#snippet ListCard(permit)}
					<Inline align="start" justify="between" gap="sm">
						<p class="truncate font-medium">{permit.permit_number}</p>
						<span class="shrink-0 text-xs text-muted-foreground">{permit.status}</span>
					</Inline>
					<p class="mt-1 truncate text-sm text-muted-foreground">
						{permit.permit_type} · expires {formatDate(permit.validity_range?.end)}
					</p>
				{/snippet}
			</CollectionTable>
		</Stack>
	</Scroll>
{/snippet}

<main class="h-full min-h-0">
	<Cover gap="md" top={projectSummary}>
		<Tabs
			lazyLoad={false}
			animate={false}
			config={[
				{
					name: 'coordination',
					label: 'Model & coordination',
					icon: 'lucide:box',
					content: coordination
				},
				{
					name: 'manpower',
					label: 'Manpower allocation',
					icon: 'lucide:users',
					content: manpower
				},
				{
					name: 'controls',
					label: 'Commercial & controls',
					icon: 'lucide:clipboard-check',
					content: controls
				}
			] satisfies TabConfig[]}
		/>
	</Cover>

	{#if loading}
		<p class="sr-only" aria-live="polite">Loading project operating context.</p>
	{/if}
</main>
