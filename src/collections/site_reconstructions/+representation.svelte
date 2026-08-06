<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Bound, Grid, Inline, Scroll, Split, Stack } from '@norbital-ai/ui/layout';
	import SiteDisplay from '../../lib/site-viewer/site_display.svelte';
	import { formatQuantity, substrateDefinition } from '../../lib/reclamation/cost.js';
	import { substrateLabel } from '../../lib/reclamation/i18n.js';
	import {
		parseReconstructionMetrics,
		parseStitchReport,
		parseStitchedModel,
		parseSubstrateQuantities
	} from '../../lib/reclamation/reconstruction-json.js';
	import { formatNumber } from '../../lib/format.js';
	import type { RepresentationProps } from './$types.js';

	/**
	 * One stitch revision, read-only.
	 *
	 * Reconstructions are written by the reconstruction automations and are never
	 * edited: an estimate points at a revision, so changing one after the fact
	 * would rewrite history under a price.
	 *
	 * Every stored blob is validated rather than asserted. This surface is the one
	 * that shows failed revisions, and a failed run records a report holding only
	 * the input fingerprint — asserted as a `StitchReport`, that rendered
	 * `warnings.length` of an array that was never there.
	 */
	let { record }: RepresentationProps = $props();

	const i18n = useI18n<TenantI18nKeys>();
	const { t } = i18n;

	const model = $derived(parseStitchedModel(record?.model_json));
	const report = $derived(parseStitchReport(record?.report_json));
	const metrics = $derived(parseReconstructionMetrics(record?.metrics_json));
	const quantities = $derived(parseSubstrateQuantities(record?.quantities_json) ?? []);
</script>

{#snippet detail()}
	<Scroll name={t('component.reconstruction_detail')} class="pr-1">
		<Stack gap="lg" class="pb-4">
			<Stack as="header" gap="xs" class="border-b pb-4">
				<h2 class="text-heading">
					{t('app.reclamation_projects.revision_n', { revision: formatNumber(record?.revision) })}
				</h2>
				<p class="text-sm text-muted-foreground">
					{t('component.revision_subtitle', {
						status:
							record?.status === 'ready'
								? t('component.status_stitched')
								: t('component.status_failed'),
						engine: record?.engine_version ?? '—',
						cell: formatNumber(record?.integration_cell_m, 1)
					})}
				</p>
			</Stack>

			{#if record?.status === 'failed'}
				<p
					class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
				>
					{record.failure_reason}
				</p>
			{/if}

			<Grid minimum="compact" class="text-sm">
				<div>
					<p class="text-xs text-muted-foreground">{t('component.platform_area')}</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{formatNumber((metrics?.platformAreaM2 ?? 0) / 10_000, 1)} ha
					</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">{t('component.works_footprint')}</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{formatNumber((metrics?.worksFootprintM2 ?? 0) / 10_000, 1)} ha
					</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">{t('component.seaward_perimeter')}</p>
					<p class="mt-0.5 font-medium tabular-nums">{formatNumber(metrics?.shorelineLengthM)} m</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">{t('component.mean_max_fill_depth')}</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{formatNumber(metrics?.meanFillDepthM, 2)} / {formatNumber(metrics?.maxFillDepthM, 2)} m
					</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">{t('component.placed_volume')}</p>
					<p class="mt-0.5 font-medium tabular-nums">{formatNumber(metrics?.placedVolumeM3)} m³</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">{t('component.excavated')}</p>
					<p class="mt-0.5 font-medium tabular-nums">{formatNumber(metrics?.excavationM3)} m³</p>
				</div>
			</Grid>

			<Stack as="section" gap="sm">
				<h3 class="border-b pb-2 text-sm font-semibold">{t('component.substrates')}</h3>
				<dl class="divide-y rounded-md border bg-card text-sm">
					{#each quantities as entry (entry.substrate)}
						<div class="p-3">
							<Inline align="start" justify="between" gap="sm">
								<dt class="min-w-0 truncate font-medium">
									{substrateLabel(
										i18n,
										entry.substrate,
										substrateDefinition(entry.substrate).label
									)}
								</dt>
								<dd class="shrink-0 tabular-nums">
									{formatQuantity(entry.quantity, entry.unit)}
								</dd>
							</Inline>
							<p class="mt-1 text-xs text-muted-foreground">{entry.basis}</p>
						</div>
					{/each}
				</dl>
			</Stack>

			{#if report}
				<Stack as="section" gap="sm">
					<h3 class="border-b pb-2 text-sm font-semibold">
						{t('component.assumptions_and_checks', {
							assumptions: report.assumptions.length,
							checks: report.warnings.length
						})}
					</h3>
					{#each report.warnings as warning (warning.code + warning.message)}
						<div
							class={warning.severity === 'error'
								? 'rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive'
								: warning.severity === 'warning'
									? 'rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm'
									: 'rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground'}
						>
							<p class="font-mono text-tiny uppercase tracking-wide opacity-70">{warning.code}</p>
							<p class="mt-1">{warning.message}</p>
						</div>
					{/each}
					<div class="divide-y rounded-md border bg-card">
						{#each report.assumptions as assumption (assumption.id)}
							<details class="p-3">
								<summary class="cursor-pointer text-sm font-medium">{assumption.title}</summary>
								<Stack gap="sm" class="pt-2">
									<p class="text-sm text-muted-foreground">{assumption.detail}</p>
									<p class="text-sm">
										<span class="font-medium">{t('component.if_it_is_wrong')}</span>
										{assumption.effect}
									</p>
								</Stack>
							</details>
						{/each}
					</div>
				</Stack>

				<Stack as="section" gap="sm">
					<h3 class="border-b pb-2 text-sm font-semibold">{t('component.source_documents')}</h3>
					<div class="divide-y rounded-md border bg-card text-sm">
						{#each report.documents as document (document.kind)}
							<div class="p-3">
								<Inline justify="between" gap="sm">
									<p class="min-w-0 truncate font-medium">{document.fileName ?? document.kind}</p>
									<span class="shrink-0 text-xs text-muted-foreground">{document.format}</span>
								</Inline>
								<p class="mt-1 text-xs text-muted-foreground">{document.summary}</p>
								<p class="mt-0.5 font-mono text-tiny text-muted-foreground">
									sha256 {document.sha256.slice(0, 16)}…
								</p>
							</div>
						{/each}
					</div>
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet viewer()}
	<Bound size="full" clip class="rounded-md border bg-muted/20">
		{#if model}
			<SiteDisplay
				{model}
				label={t('component.revision_reconstruction', {
					revision: record?.revision ?? ''
				})}
			/>
		{:else}
			<Inline
				align="center"
				justify="center"
				fill
				class="px-8 text-center text-sm text-muted-foreground"
			>
				{t('component.holds_no_model')}
			</Inline>
		{/if}
	</Bound>
{/snippet}

<main class="h-full min-h-0 p-1">
	<Split
		ratio="half"
		collapse="stack"
		gap="md"
		class="h-full min-h-0"
		start={detail}
		end={viewer}
	/>
</main>
