<script lang="ts">
	import { Bound, Grid, Inline, Scroll, Split, Stack } from '@norbital-ai/ui/layout';
	import SiteDisplay from '../../lib/site-viewer/site_display.svelte';
	import type { StitchReport, StitchedModel } from '../../lib/reclamation/types.js';
	import type { RepresentationProps } from './$types.js';

	/**
	 * One stitch revision, read-only.
	 *
	 * Reconstructions are written by the project hook and are never edited: an
	 * estimate points at a revision, so changing one after the fact would rewrite
	 * history under a price.
	 */
	let { record }: RepresentationProps = $props();

	function parse<T>(json: string | null | undefined): T | null {
		if (!json) return null;
		try {
			return JSON.parse(json) as T;
		} catch {
			return null;
		}
	}

	const model = $derived(parse<StitchedModel>(record?.model_json));
	const report = $derived(parse<StitchReport>(record?.report_json));

	function number(value: number | null | undefined, digits = 0): string {
		if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

{#snippet detail()}
	<Scroll name="Reconstruction detail" class="h-full pr-1">
		<Stack gap="lg" class="pb-4">
			<Stack as="header" gap="xs" class="border-b pb-4">
				<h2 class="text-heading">Revision {number(record?.revision)}</h2>
				<p class="text-sm text-muted-foreground">
					{record?.status === 'ready' ? 'Stitched' : 'Failed'} · engine {record?.engine_version ??
						'—'} · {number(record?.integration_cell_m, 1)} m integration cell
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
					<p class="text-xs text-muted-foreground">Platform area</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{number((record?.platform_area_m2 ?? 0) / 10_000, 1)} ha
					</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">Works footprint</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{number((record?.works_footprint_m2 ?? 0) / 10_000, 1)} ha
					</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">Seaward perimeter</p>
					<p class="mt-0.5 font-medium tabular-nums">{number(record?.shoreline_length_m)} m</p>
				</div>
				<div>
					<p class="text-xs text-muted-foreground">Mean / max fill depth</p>
					<p class="mt-0.5 font-medium tabular-nums">
						{number(record?.mean_fill_depth_m, 2)} / {number(record?.max_fill_depth_m, 2)} m
					</p>
				</div>
			</Grid>

			<Stack as="section" gap="sm">
				<h3 class="border-b pb-2 text-sm font-semibold">Integrated volumes</h3>
				<dl class="divide-y rounded-md border bg-card text-sm">
					{#each [['Rock armour', record?.rock_armor_m3, 'm³'], ['Geofabric', record?.geofabric_m2, 'm²'], ['Dredged rock', record?.dredged_rock_m3, 'm³'], ['Sand key', record?.sand_key_m3, 'm³'], ['Sand fill', record?.sand_fill_m3, 'm³'], ['Dredged fill', record?.dredged_fill_m3, 'm³'], ['Existing bund displaced', record?.structure_displacement_m3, 'm³'], ['Below the surveyed bed', record?.excavation_m3, 'm³']] as entry (entry[0])}
						<Inline as="div" justify="between" gap="sm" class="p-3">
							<dt>{entry[0]}</dt>
							<dd class="tabular-nums">{number(entry[1] as number)} {entry[2]}</dd>
						</Inline>
					{/each}
				</dl>
			</Stack>

			{#if report}
				<Stack as="section" gap="sm">
					<h3 class="border-b pb-2 text-sm font-semibold">
						Assumptions ({report.assumptions.length}) and checks ({report.warnings.length})
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
								<p class="mt-2 text-sm text-muted-foreground">{assumption.detail}</p>
								<p class="mt-2 text-sm">
									<span class="font-medium">If it is wrong:</span>
									{assumption.effect}
								</p>
							</details>
						{/each}
					</div>
				</Stack>

				<Stack as="section" gap="sm">
					<h3 class="border-b pb-2 text-sm font-semibold">Source documents</h3>
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
			<SiteDisplay {model} label={`Revision ${record?.revision} reconstruction`} />
		{:else}
			<Inline
				align="center"
				justify="center"
				class="h-full px-8 text-center text-sm text-muted-foreground"
			>
				This revision holds no model.
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
