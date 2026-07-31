<script lang="ts">
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import InfoHint from './info-hint.svelte';
	import { cn } from '@norbital-ai/ui/utils';
	import type { SiteLayer, SiteViewerStats } from '../../../lib/site-viewer/site_viewer.types.js';
	import { SURFACE_NOTE } from '../../../lib/site-viewer/surface-notes.js';
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

	const errors = $derived((report?.warnings ?? []).filter((entry) => entry.severity === 'error'));
	const cautions = $derived(
		(report?.warnings ?? []).filter((entry) => entry.severity === 'warning')
	);
	const notices = $derived((report?.warnings ?? []).filter((entry) => entry.severity === 'info'));

	function number(value: number | null | undefined, digits = 0): string {
		if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

<Stack gap="lg" class="pb-4">
	<Stack as="section" gap="sm">
		<Inline align="center" gap="xs" class="border-b pb-2">
			<h3 class="text-sm font-semibold">Layers</h3>
			<InfoHint
				text="Switch a layer off to look inside the solid. Visibility changes the live scene only — nothing is recalculated and no volume moves."
			/>
		</Inline>
		{#if layers.length === 0}
			<p class="text-sm text-muted-foreground">Building the surfaces…</p>
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
									<InfoHint label={`About ${layer.label}`} text={SURFACE_NOTE[layer.id]} />
								</span>
							{/if}
							<span class="shrink-0 text-xs tabular-nums text-muted-foreground">
								{number(layer.triangles / 1000, 1)}k tri
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Stack>

	{#if stats}
		<p class="text-xs text-muted-foreground tabular-nums">
			{number(stats.triangleCount)} triangles at {number(stats.renderCellM, 1)} m · volumes integrated
			server-side at {number(metrics.integrationCellM, 1)} m
		</p>
	{/if}

	<Stack as="section" gap="sm">
		<h3 class="border-b pb-2 text-sm font-semibold">Measured from the solid</h3>
		<dl class="grid grid-cols-2 gap-3 text-sm">
			<div>
				<dt class="text-xs text-muted-foreground">Platform area</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{number(metrics.platformAreaM2 / 10_000, 1)} ha
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Works footprint</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{number(metrics.worksFootprintM2 / 10_000, 1)} ha
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Seaward perimeter</dt>
				<dd class="mt-0.5 font-medium tabular-nums">{number(metrics.shorelineLengthM)} m</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Mean / max fill depth</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{number(metrics.meanFillDepthM, 2)} / {number(metrics.maxFillDepthM, 2)} m
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Existing bund displaced</dt>
				<dd class="mt-0.5 font-medium tabular-nums">
					{number(metrics.structureDisplacementM3)} m³
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Below the surveyed bed</dt>
				<dd class="mt-0.5 font-medium tabular-nums">{number(metrics.excavationM3)} m³</dd>
			</div>
		</dl>
	</Stack>

	{#if report}
		<Stack as="section" gap="sm">
			<div class="border-b pb-2">
				<h3 class="text-sm font-semibold">
					Checks
					{#if report.warnings.length > 0}
						<span class="ml-1 font-normal text-muted-foreground"
							>({report.warnings.length} flagged)</span
						>
					{/if}
				</h3>
			</div>
			{#if report.warnings.length === 0}
				<p class="text-sm text-muted-foreground">
					No document conflicts or extraction errors were flagged.
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

			{#if report.layerClassification && report.layerClassification.length > 0}
				<details class="rounded-md border bg-card p-3">
					<summary class="cursor-pointer text-sm font-medium">
						How each section layer was read
					</summary>
					<ul class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
						{#each report.layerClassification as entry (entry.layer)}
							<li class="flex items-center justify-between gap-2">
								<span class="truncate font-mono">{entry.layer}</span>
								<span
									class={entry.role === 'surface'
										? 'shrink-0 text-muted-foreground'
										: 'shrink-0 text-amber-600'}
								>
									{entry.role}
								</span>
							</li>
						{/each}
					</ul>
					<p class="mt-2 text-xs text-muted-foreground">
						A layer read as <span class="font-medium">internal</span> is excluded from the finished
						surface. Correct any of these with <code>profileLayers</code> in the project overrides.
					</p>
				</details>
			{/if}
		</Stack>
	{/if}
</Stack>
