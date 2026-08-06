<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
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
	import { z } from 'zod';
	import { formatSingaporeInstant } from '../../lib/instant-format.js';
	import JobsRepresentation from '../jobs/+representation.svelte';

	let { record, refresh }: { record: Row; refresh(): Promise<void> } = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const documentAssetSchema = z.object({
		norbital_id: z.string().uuid(),
		file_name: z.string(),
		file_size: z.number().nullable().optional(),
		storage_key: z.string()
	});

	const jobQuery = $derived(
		client.db.jobs.findMany({
			where: { norbital_id: { eq: record.job_id } },
			limit: 1
		})
	);
	const variationsQuery = $derived(
		client.db.variation_requests.findMany({
			where: { job_assignment_id: { eq: record.norbital_id } },
			orderBy: { requested_at: 'desc' },
			limit: 50
		})
	);
	const directEvidenceQuery = $derived(
		client.db.photo_evidence.findMany({
			where: { job_assignment_id: { eq: record.norbital_id } },
			orderBy: { norbital_created_at: 'desc' },
			limit: 250
		})
	);

	const scopedEvidence = $derived(
		(directEvidenceQuery.current ?? []).filter(
			(evidence) => evidence.job_assignment_id === record.norbital_id
		)
	);
	const evidenceAssetIds = $derived([
		...new Set(scopedEvidence.map((evidence) => evidence.document_asset_id))
	]);
	const evidenceAssetsQuery = $derived(
		evidenceAssetIds.length
			? client.db.document_asset.findMany({
					where: { norbital_id: { in: evidenceAssetIds } },
					limit: evidenceAssetIds.length
				})
			: null
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
		if (source == null || typeof source !== 'object') return t('component.workspace_upload');
		const kind = Reflect.get(source, 'kind');
		if (kind !== 'channel') return t('component.workspace_upload');
		const provider = Reflect.get(source, 'provider');
		return typeof provider === 'string'
			? t('component.provider_agent', { provider })
			: t('component.channel_agent');
	}

	function formatMoney(value: unknown): string {
		if (value == null || typeof value !== 'object') return t('component.not_recorded');
		const amount = Reflect.get(value, 'value');
		const currency = Reflect.get(value, 'currency');
		if (typeof amount !== 'number' || typeof currency !== 'string')
			return t('component.not_recorded');
		return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(amount);
	}
</script>

{#snippet jobScopeHeader()}
	<div>
		<h3 id="assignment-job-scope-heading" class="text-sm font-semibold">
			{t('component.job_scope')}
		</h3>
		<p class="text-sm text-muted-foreground">
			{t('component.job_scope_description')}
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
			<Scroll name={t('component.job_scope_status')}>
				<p class="text-sm text-destructive">{t('component.job_load_failed')}</p>
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
						{t('component.assignment_and_activity')}
					</h3>
					<p class="text-sm text-muted-foreground">
						{t('component.assignment_and_activity_description')}
					</p>
				</div>
				<Grid minimum="panel">
					<Field name="status" />
					<Field name="dispatched_at" label={t('component.dispatched_at')} />
					<Field name="completed_at" label={t('component.completed_at')} />
					<Field name="amount_charged" label={t('component.value_charged')} />
					<Column span="all">
						<Field name="summary" label={t('component.completion_summary')} />
					</Column>
					<Column span="all"
						><Field name="location" label={t('component.reported_location')} /></Column
					>
				</Grid>
			</Stack>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet variationHistory()}
	<Scroll name={t('component.variation_history')}>
		<Stack as="section" aria-labelledby="variation-history-heading" gap="md">
			<Inline justify="between" gap="sm">
				<div>
					<h4 id="variation-history-heading" class="text-sm font-semibold">
						{t('component.variations')}
					</h4>
					<p class="text-xs text-muted-foreground">{t('component.variations_description')}</p>
				</div>
				<span class="text-xs tabular-nums text-muted-foreground">
					{t('component.recorded_count', { count: variationsQuery.current?.length ?? 0 })}
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
							{t('component.requested_at_instant', {
								instant: formatSingaporeInstant(variation.requested_at)
							})}
						</p>
					</Stack>
				{:else}
					<div
						class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
					>
						{t('component.no_variations')}
					</div>
				{/each}
			</Stack>
		</Stack>
	</Scroll>
{/snippet}

{#snippet photoGallery()}
	<Scroll name={t('component.assignment_evidence')}>
		<Stack as="section" aria-labelledby="evidence-heading" gap="md">
			<Inline justify="between" gap="sm">
				<div>
					<h4 id="evidence-heading" class="text-sm font-semibold">{t('component.evidence')}</h4>
					<p class="text-xs text-muted-foreground">{t('component.evidence_description')}</p>
				</div>
				<span class="text-xs tabular-nums text-muted-foreground">
					{evidenceLoading
						? t('component.loading_evidence')
						: t('component.captured_for_assignment', { count: photoCards.length })}
				</span>
			</Inline>
			{#if directEvidenceQuery.error || evidenceAssetsQuery?.error}
				<p
					class="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
					role="alert"
				>
					{t('component.evidence_load_failed')}
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
								aria-label={t('component.open_photo', { name: photo.name })}
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
										{photo.flags.length > 0
											? photo.flags.join(', ')
											: t('component.integrity_passed')}
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
								{t('component.no_evidence')}
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
			label: t('component.job_scope'),
			icon: 'lucide:briefcase-business',
			content: jobScope
		},
		{
			name: 'activity',
			label: t('component.status_and_activity'),
			icon: 'lucide:clipboard-check',
			content: statusAndActivity
		},
		{
			name: 'variations',
			label: t('component.variations'),
			icon: 'lucide:git-pull-request-arrow',
			content: variationHistory
		},
		{
			name: 'photos',
			label: t('component.photos'),
			icon: 'lucide:images',
			content: photoGallery
		}
	] satisfies TabConfig[]}
/>
