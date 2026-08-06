<script lang="ts">
	import { Column, Columns, Inline, Stack } from '@norbital-ai/ui/layout';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import InfoHint from './info-hint.svelte';
	import { cn } from '@norbital-ai/ui/utils';
	import type { SiteLayer, SiteViewerStats } from '../../../lib/site-viewer/site_viewer.types.js';
	import { SURFACE_NOTE } from '../../../lib/site-viewer/surface-notes.js';
	import { formatNumber } from '../../../lib/format.js';
	import type { ReconstructionMetrics, StitchReport } from '../../../lib/reclamation/types.js';

	/**
	 * What is in the model, and how much of it to draw.
	 *
	 * The layer switches drive the viewer beside this panel directly — toggling
	 * one changes mesh visibility in the live scene and never re-tessellates.
	 *
	 * There is no quality control: the surface is always drawn at the finest cell
	 * the vertex budget allows. A coarser option only ever existed to save frames
	 * on a machine that did not need saving, and a half-resolution solid invites
	 * exactly the wrong conclusion when it is being checked against a drawing.
	 */
	let {
		layers,
		visible,
		onToggle,
		stats,
		metrics,
		report
	}: {
		layers: readonly SiteLayer[];
		visible: Readonly<Record<string, boolean>>;
		onToggle: (id: string) => void;
		stats: SiteViewerStats | null;
		metrics: ReconstructionMetrics;
		report: StitchReport | null;
	} = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const errors = $derived((report?.warnings ?? []).filter((entry) => entry.severity === 'error'));
	const cautions = $derived(
		(report?.warnings ?? []).filter((entry) => entry.severity === 'warning')
	);
	const notices = $derived((report?.warnings ?? []).filter((entry) => entry.severity === 'info'));
	const assumptions = $derived(report?.assumptions ?? []);
</script>

<Stack gap="lg" class="pb-4">
	<Stack as="section" gap="sm">
		<Inline align="center" gap="xs" class="border-b pb-2">
			<h3 class="text-sm font-semibold">{t('component.layers')}</h3>
			<InfoHint text={t('component.layers_hint')} />
		</Inline>
		{#if layers.length === 0}
			<p class="text-sm text-muted-foreground">{t('component.building_surfaces')}</p>
		{:else}
			<ul class="divide-y rounded-md border bg-card">
				{#each layers as layer (layer.id)}
					<li>
						<button
							type="button"
							class={cn(
								'flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60',
								!(visible[layer.id] ?? true) && 'opacity-45'
							)}
							onclick={() => onToggle(layer.id)}
							aria-pressed={visible[layer.id] ?? true}
						>
							<span class="size-3 shrink-0 rounded-[3px] border" style={`background:${layer.color}`}
							></span>
							<span class="min-w-0 flex-1 truncate">{layer.label}</span>
							{#if SURFACE_NOTE[layer.id]}
								<span class="shrink-0" title={SURFACE_NOTE[layer.id]}>
									<InfoHint
										label={t('component.about_label', { label: layer.label })}
										text={SURFACE_NOTE[layer.id]}
									/>
								</span>
							{/if}
							<span class="shrink-0 text-xs tabular-nums text-muted-foreground">
								{formatNumber(layer.triangles / 1000, 1)}k tri
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Stack>

	{#if stats}
		<p class="text-xs text-muted-foreground tabular-nums">
			{formatNumber(stats.triangleCount)} triangles at {formatNumber(stats.renderCellM, 1)} m · volumes
			integrated server-side at {formatNumber(metrics.integrationCellM, 1)} m
		</p>
	{/if}

	<Stack as="section" gap="sm">
		<h3 class="border-b pb-2 text-sm font-semibold">{t('component.measured_from_solid')}</h3>
		<Columns as="dl" count={2} gap="md" class="text-sm">
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.platform_area')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{formatNumber(metrics.platformAreaM2 / 10_000, 1)} ha
				</dd>
			</Column>
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.works_footprint')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{formatNumber(metrics.worksFootprintM2 / 10_000, 1)} ha
				</dd>
			</Column>
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.seaward_perimeter')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">{formatNumber(metrics.shorelineLengthM)} m</dd>
			</Column>
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.mean_max_fill_depth')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{formatNumber(metrics.meanFillDepthM, 2)} / {formatNumber(metrics.maxFillDepthM, 2)} m
				</dd>
			</Column>
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.existing_bund_displaced')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{formatNumber(metrics.structureDisplacementM3)} m³
				</dd>
			</Column>
			<Column>
				<dt class="text-xs text-muted-foreground">{t('component.below_surveyed_bed')}</dt>
				<dd class="mt-0.5 font-medium tabular-nums">{formatNumber(metrics.excavationM3)} m³</dd>
			</Column>
		</Columns>
	</Stack>

	{#if report}
		<Stack as="section" gap="sm">
			<h3 class="border-b pb-2 text-sm font-semibold">
				{t('component.checks_basis')}
				<span class="ml-1 font-normal text-muted-foreground">
					{t('component.checks_basis_counts', {
						flagged: report.warnings.length,
						assumed: assumptions.length
					})}
				</span>
			</h3>
			{#if report.warnings.length === 0}
				<p class="text-sm text-muted-foreground">
					{t('component.no_checks_flagged')}
				</p>
			{/if}

			{#each [...errors, ...cautions, ...notices] as warning (warning.code + warning.message)}
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

			{#if assumptions.length > 0}
				<div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
					<p class="font-medium">{t('component.assumptions_not_supplied')}</p>
					<p class="mt-1 text-xs text-muted-foreground">
						{t('component.assumptions_verify')}
					</p>
				</div>
				<div class="divide-y rounded-md border bg-card">
					{#each assumptions as assumption (assumption.id)}
						<details class="p-3">
							<summary class="cursor-pointer text-sm font-medium">{assumption.title}</summary>
							<Stack gap="sm" class="pt-2">
								<p class="text-sm text-muted-foreground">{assumption.detail}</p>
								<p class="text-sm">
									<span class="font-medium">{t('component.effect_if_incorrect')}</span>
									{assumption.effect}
								</p>
							</Stack>
						</details>
					{/each}
				</div>
			{/if}

			{#if report.layerClassification && report.layerClassification.length > 0}
				<details class="rounded-md border bg-card p-3">
					<summary class="cursor-pointer text-sm font-medium">
						{t('component.layer_read_heading')}
					</summary>
					<Stack gap="sm" class="pt-2">
						<Columns as="ul" count={2} gap="sm" class="text-xs">
							{#each report.layerClassification as entry (entry.layer)}
								<Column as="li">
									<Inline justify="between" gap="sm">
										<span class="truncate font-mono">{entry.layer}</span>
										<span
											class={entry.role === 'surface'
												? 'shrink-0 text-muted-foreground'
												: 'shrink-0 text-amber-600'}
										>
											{entry.role}
										</span>
									</Inline>
								</Column>
							{/each}
						</Columns>
						<p class="text-xs text-muted-foreground">
							{t('component.layer_read_note')}
						</p>
					</Stack>
				</details>
			{/if}
		</Stack>
	{/if}
</Stack>
