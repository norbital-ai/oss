<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import {
		Cluster,
		Column,
		Cover,
		Frame,
		Grid,
		Inline,
		Scroll,
		Stack
	} from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { formatFileSize } from '@norbital-ai/ui/utils';
	import Icon from '@iconify/svelte';
	import { watch } from 'runed';
	import { z } from 'zod';
	import { formatSingaporeInstant } from '../../lib/instant-format.js';
	import JobsRepresentation from '../jobs/+representation.svelte';

	let { record, refresh }: { record: Row; refresh(): Promise<void> } = $props();

	const documentAssetSchema = z.object({
		norbital_id: z.string().uuid(),
		file_name: z.string(),
		file_size: z.number().nullable().optional(),
		storage_key: z.string()
	});

	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial handle.
	let jobQuery = $state(
		client.db.jobs.findMany({
			where: { norbital_id: { eq: record.job_id } },
			limit: 1
		})
	);
	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial handle.
	let variationsQuery = $state(
		client.db.variation_requests.findMany({
			where: { job_assignment_id: { eq: record.norbital_id } },
			orderBy: { requested_at: 'desc' },
			limit: 50
		})
	);
	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial handle.
	let directEvidenceQuery = $state(
		client.db.photo_evidence.findMany({
			where: { job_assignment_id: { eq: record.norbital_id } },
			orderBy: { norbital_created_at: 'desc' },
			limit: 250
		})
	);
	const recordQueryKey = $derived(`${record.norbital_id}:${record.job_id}`);
	watch(
		() => recordQueryKey,
		() => {
			jobQuery = client.db.jobs.findMany({
				where: { norbital_id: { eq: record.job_id } },
				limit: 1
			});
			variationsQuery = client.db.variation_requests.findMany({
				where: { job_assignment_id: { eq: record.norbital_id } },
				orderBy: { requested_at: 'desc' },
				limit: 50
			});
			directEvidenceQuery = client.db.photo_evidence.findMany({
				where: { job_assignment_id: { eq: record.norbital_id } },
				orderBy: { norbital_created_at: 'desc' },
				limit: 250
			});
		},
		{ lazy: true }
	);

	const scopedEvidence = $derived(
		(directEvidenceQuery.current ?? []).filter(
			(evidence) => evidence.job_assignment_id === record.norbital_id
		)
	);
	const evidenceAssetIds = $derived([
		...new Set(scopedEvidence.map((evidence) => evidence.document_asset_id))
	]);
	const evidenceAssetIdsKey = $derived(evidenceAssetIds.join(','));
	type EvidenceAssetsQuery = ReturnType<typeof client.db.document_asset.findMany>;
	let evidenceAssetsQuery = $state<EvidenceAssetsQuery | null>(null);
	let loadedEvidenceAssetIdsKey: string | undefined;
	watch(
		() => evidenceAssetIdsKey,
		(idsKey) => {
			if (loadedEvidenceAssetIdsKey === idsKey) return;
			loadedEvidenceAssetIdsKey = idsKey;
			evidenceAssetsQuery = evidenceAssetIds.length
				? client.db.document_asset.findMany({
						where: { norbital_id: { in: evidenceAssetIds } },
						limit: evidenceAssetIds.length
					})
				: null;
		}
	);
	const evidenceByAssetId = $derived(
		new Map(scopedEvidence.map((evidence) => [evidence.document_asset_id, evidence]))
	);
	const photoCards = $derived(
		(evidenceAssetsQuery?.current ?? []).flatMap((candidate) => {
			const parsed = documentAssetSchema.safeParse(candidate);
			if (!parsed.success) return [];
			const evidence = evidenceByAssetId.get(parsed.data.norbital_id);
			if (!evidence) return [];
			return [
				{
					id: evidence.norbital_id,
					name: parsed.data.file_name,
					fileSize: parsed.data.file_size,
					url: `/api/files/download/${encodeURIComponent(parsed.data.storage_key)}`,
					flags: evidence.flags ?? [],
					source: evidenceSource(evidence.source),
					capturedAt: formatSingaporeInstant(evidence.norbital_created_at)
				}
			];
		})
	);
	const evidenceLoading = $derived(
		directEvidenceQuery.loading ||
			(evidenceAssetIds.length > 0 && (evidenceAssetsQuery == null || evidenceAssetsQuery.loading))
	);

	function evidenceSource(source: unknown): string {
		if (source == null || typeof source !== 'object') return 'Workspace upload';
		const kind = Reflect.get(source, 'kind');
		if (kind !== 'channel') return 'Workspace upload';
		const provider = Reflect.get(source, 'provider');
		return typeof provider === 'string' ? `${provider} agent` : 'Channel agent';
	}

	function formatMoney(value: unknown): string {
		if (value == null || typeof value !== 'object') return 'Not recorded';
		const amount = Reflect.get(value, 'value');
		const currency = Reflect.get(value, 'currency');
		if (typeof amount !== 'number' || typeof currency !== 'string') return 'Not recorded';
		return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(amount);
	}
</script>

{#snippet jobScopeHeader()}
	<div>
		<h3 id="assignment-job-scope-heading" class="text-sm font-semibold">Job scope</h3>
		<p class="text-sm text-muted-foreground">
			Site, schedule, work nature, and the description the contractor receives.
		</p>
	</div>
{/snippet}

{#snippet jobScope()}
	<Cover gap="md" top={jobScopeHeader}>
		{#if jobQuery.current?.[0]}
			<JobsRepresentation record={jobQuery.current[0]} close={() => undefined} {refresh} />
		{:else if jobQuery.loading}
			<div
				class="h-32 rounded-md bg-muted/50 motion-safe:animate-pulse"
				aria-label="Loading job"
			></div>
		{:else}
			<Scroll name="Job scope status">
				<p class="text-sm text-destructive">The assigned job could not be loaded.</p>
			</Scroll>
		{/if}
	</Cover>
{/snippet}

{#snippet statusAndActivity()}
	<CollectionForm
		{client}
		collection="job_assignments"
		recordId={record.norbital_id}
		defaultValues={record}
	>
		{#snippet children({ Field })}
			<Stack gap="md">
				<div>
					<h3 id="assignment-activity-heading" class="text-sm font-semibold">
						Assignment and activity
					</h3>
					<p class="text-sm text-muted-foreground">
						Completion, captured evidence, variations, and charges are retained against the
						assignment.
					</p>
				</div>
				<Grid minimum="panel">
					<Field name="status" />
					<Field name="dispatched_at" label="Dispatched at" />
					<Field name="completed_at" label="Completed at" />
					<Field name="amount_charged" label="Value charged" />
					<Column span="all">
						<Field name="summary" label="Completion / visit summary" />
					</Column>
					<Column span="all"><Field name="location" label="Reported location" /></Column>
				</Grid>
			</Stack>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet variationHistory()}
	<Scroll name="Variation history">
		<Stack as="section" aria-labelledby="variation-history-heading" gap="md">
			<Inline justify="between" gap="sm">
				<div>
					<h4 id="variation-history-heading" class="text-sm font-semibold">Variations</h4>
					<p class="text-xs text-muted-foreground">Scope changes captured by the field agent.</p>
				</div>
				<span class="text-xs tabular-nums text-muted-foreground">
					{variationsQuery.current?.length ?? 0} recorded
				</span>
			</Inline>
			<Stack gap="sm">
				{#each variationsQuery.current ?? [] as variation (variation.norbital_id)}
					<Stack as="section" gap="sm" class="rounded-md border border-border bg-card p-3">
						<Inline align="start" justify="between" gap="sm">
							<div>
								<p class="text-sm font-medium">{variation.title}</p>
								<p class="mt-1 text-sm text-muted-foreground">{variation.description}</p>
							</div>
							<span class="shrink-0 text-sm font-medium">{formatMoney(variation.amount)}</span>
						</Inline>
						<p class="text-xs text-muted-foreground">
							Requested {formatSingaporeInstant(variation.requested_at)}
						</p>
					</Stack>
				{:else}
					<div
						class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
					>
						No variation requests were recorded for this assignment.
					</div>
				{/each}
			</Stack>
		</Stack>
	</Scroll>
{/snippet}

{#snippet photoGallery()}
	<Scroll name="Assignment evidence">
		<Stack as="section" aria-labelledby="evidence-heading" gap="md">
			<Inline justify="between" gap="sm">
				<div>
					<h4 id="evidence-heading" class="text-sm font-semibold">Evidence</h4>
					<p class="text-xs text-muted-foreground">Selected photos and their integrity results.</p>
				</div>
				<span class="text-xs tabular-nums text-muted-foreground">
					{evidenceLoading
						? 'Loading evidence…'
						: `${photoCards.length} captured for this assignment`}
				</span>
			</Inline>
			{#if directEvidenceQuery.error || evidenceAssetsQuery?.error}
				<p
					class="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
					role="alert"
				>
					Could not load the photographic evidence.
				</p>
			{:else if evidenceLoading && photoCards.length === 0}
				<Grid minimum="card" gap="md" aria-label="Loading photographic evidence">
					{#each Array(3) as _}
						<div class="h-48 rounded-md bg-muted/50 motion-safe:animate-pulse"></div>
					{/each}
				</Grid>
			{:else}
				<Grid minimum="card" gap="md">
					{#each photoCards as photo (photo.id)}
						<figure class="min-w-0 rounded-md border border-border bg-card">
							<a
								href={photo.url}
								target="_blank"
								rel="noreferrer"
								class="group block bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
								aria-label={`Open ${photo.name} at full size`}
							>
								<Frame ratio="landscape">
									<img
										src={photo.url}
										alt={photo.name}
										class="transition-opacity duration-150 group-hover:opacity-90"
										loading="lazy"
									/>
								</Frame>
							</a>
							<Stack as="section" gap="sm" class="p-3">
								<Inline align="start" gap="xs">
									<Icon
										icon={photo.flags.length > 0 ? 'lucide:scan-warning' : 'lucide:image-check'}
										class={photo.flags.length > 0
											? 'mt-0.5 size-4 shrink-0 text-destructive'
											: 'mt-0.5 size-4 shrink-0 text-success'}
									/>
									<Stack gap="none" class="min-w-0">
										<p class="truncate text-sm font-medium">{photo.name}</p>
										<p class="text-xs text-muted-foreground">
											{photo.source} · {photo.capturedAt}
										</p>
									</Stack>
								</Inline>
								<Cluster justify="between" gap="xs" class="text-xs">
									<span
										class={photo.flags.length > 0 ? 'text-destructive' : 'text-muted-foreground'}
									>
										{photo.flags.length > 0 ? photo.flags.join(', ') : 'Integrity checks passed'}
									</span>
									{#if photo.fileSize != null}
										<span class="shrink-0 tabular-nums text-muted-foreground">
											{formatFileSize(photo.fileSize)}
										</span>
									{/if}
								</Cluster>
							</Stack>
						</figure>
					{:else}
						<Column span="all">
							<div
								class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								No photographic evidence has been attached yet.
							</div>
						</Column>
					{/each}
				</Grid>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

<Tabs
	animate={false}
	config={[
		{
			name: 'scope',
			label: 'Job scope',
			icon: 'lucide:briefcase-business',
			content: jobScope
		},
		{
			name: 'activity',
			label: 'Status and activity',
			icon: 'lucide:clipboard-check',
			content: statusAndActivity
		},
		{
			name: 'variations',
			label: 'Variations',
			icon: 'lucide:git-pull-request-arrow',
			content: variationHistory
		},
		{
			name: 'photos',
			label: 'Photos',
			icon: 'lucide:images',
			content: photoGallery
		}
	] satisfies TabConfig[]}
/>
