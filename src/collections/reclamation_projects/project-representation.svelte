<script lang="ts">
	import { client } from '$pod/client';
	import { Button } from '@norbital-ai/ui/button';
	import { Bound, Cluster, Inline, Scroll, Split, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import SiteDisplay from '../../lib/site-viewer/site_display.svelte';
	import type { SiteLayer, SiteViewerStats } from '../../lib/site-viewer/site_viewer.types.js';
	import type { CostLevers, RateRow } from '../../lib/reclamation/cost.js';
	import type { ReconstructionMetrics } from '../../lib/reclamation/types.js';
	import {
		parseReconstructionMetrics,
		parseStitchReport,
		parseStitchedModel,
		parseSubstrateQuantities
	} from '../../lib/reclamation/reconstruction-json.js';
	import { calendarDateInTimeZone, PROJECT_TIME_ZONE } from '../../lib/calendar.js';
	import CostPanel from './panels/cost-panel.svelte';
	import DocumentsPanel from './panels/documents-panel.svelte';
	import ModelPanel from './panels/model-panel.svelte';
	import SectionPanel from './panels/section-panel.svelte';
	import type { Row } from './$types.js';

	/**
	 * Project detail: what the project holds on the left, what it built on the right.
	 *
	 * The left pane owns every control — layers, cost levers — and
	 * the right pane holds one viewer that stays mounted across tab changes, so
	 * moving between documents and cost never costs a re-tessellation.
	 */
	let { record }: { record: Row } = $props();

	const EMPTY_METRICS: ReconstructionMetrics = {
		platformAreaM2: 0,
		worksFootprintM2: 0,
		armorFaceAreaM2: 0,
		shorelineLengthM: 0,
		meanFillDepthM: 0,
		maxFillDepthM: 0,
		integratedCells: 0,
		integrationCellM: 0,
		structureDisplacementM3: 0,
		trenchExcavationM3: 0,
		excavationM3: 0,
		placedVolumeM3: 0
	};

	const projectId = $derived(record.norbital_id);
	const currency = $derived(record.currency?.trim() || 'SGD');
	// The site's calendar day. The server hook prices against the same one, so the rates shown here
	// and the rates the estimate is built from cannot be a day apart.
	const today = calendarDateInTimeZone(new Date(), PROJECT_TIME_ZONE);

	const runsQuery = $derived(
		client.db.site_reconstructions.findMany({
			where: { project_id: { eq: projectId } },
			orderBy: { revision: 'desc' },
			limit: 10
		})
	);
	const ratesQuery = $derived(
		client.db.cost_rates.findMany({
			where: { validity_range: { contains_date: today } },
			limit: 100
		})
	);
	type ReconstructionRow = NonNullable<(typeof runsQuery)['current']>[number];
	let commandReconstruction = $state<ReconstructionRow | null>(null);

	const runs = $derived.by(() => {
		const replicated = runsQuery.current ?? [];
		if (
			!commandReconstruction ||
			replicated.some((run) => run.norbital_id === commandReconstruction?.norbital_id)
		) {
			return replicated;
		}
		return [commandReconstruction, ...replicated];
	});
	const latestRun = $derived(runs[0]);
	const latestReady = $derived(runs.find((run) => run.status === 'ready'));

	// One shape, validated once. The reconstruction stores the whole metric record, so nothing here
	// re-assembles it field by field — and a blob that does not match the engine reading it comes
	// back as `null` and renders as "nothing built yet" rather than as a half-populated model.
	const model = $derived(parseStitchedModel(latestReady?.model_json));
	const report = $derived(parseStitchReport(latestReady?.report_json));
	const quantities = $derived(parseSubstrateQuantities(latestReady?.quantities_json) ?? []);
	const metrics = $derived(parseReconstructionMetrics(latestReady?.metrics_json) ?? EMPTY_METRICS);

	const rates = $derived(
		(ratesQuery.current ?? []).flatMap((row): RateRow[] => {
			const rate = row.rate?.value;
			if (!row.substrate || !row.unit || typeof rate !== 'number') return [];
			return [
				{
					substrate: row.substrate as RateRow['substrate'],
					unit: row.unit as RateRow['unit'],
					rate,
					currency: row.rate?.currency ?? currency
				}
			];
		})
	);

	/* ------------------------------------------------------------- viewer state */

	/**
	 * Always the finest surface the vertex budget allows.
	 *
	 * `resolveCell` coarsens whatever it is handed until the mesh fits
	 * `settings.maxCells`, so asking for a metre asks for the best available and
	 * never for something unbounded.
	 */
	const RENDER_CELL_M = 1;
	let layers = $state<readonly SiteLayer[]>([]);
	let stats = $state<SiteViewerStats | null>(null);
	let visible = $state<Record<string, boolean>>({});

	function onLayers(next: readonly SiteLayer[]): void {
		layers = next;
		const merged: Record<string, boolean> = {};
		for (const layer of next) merged[layer.id] = visible[layer.id] ?? true;
		visible = merged;
	}

	function toggleLayer(id: string): void {
		visible = { ...visible, [id]: !(visible[id] ?? true) };
	}

	/* --------------------------------------------------------------- documents */

	const documentSlots = [
		{
			kind: 'floor_plan',
			label: 'Floor plan',
			field: 'floor_plan_document',
			hint: 'DXF site key plan, or a digitised plan JSON.'
		},
		{
			kind: 'bathymetry',
			label: 'Bathymetry',
			field: 'bathymetry_document',
			hint: 'XYZ or CSV soundings in the same frame as the plan.'
		},
		{
			kind: 'cross_section',
			label: 'Cross sections',
			field: 'cross_section_document',
			hint: 'Authored DXF section sheet, or a digitised section JSON. A DWG must be exported to DXF first — every CAD application writes it.'
		}
	] as const;

	const slots = $derived(
		documentSlots.map((slot) => ({
			kind: slot.kind,
			label: slot.label,
			hint: slot.hint,
			uploaded: typeof record[slot.field] === 'string' && record[slot.field] !== ''
		}))
	);
	const documentsReady = $derived(slots.every((slot) => slot.uploaded));

	/* ----------------------------------------------------------------- actions */

	let rebuilding = $state(false);
	let rebuildMessage = $state<string | null>(null);

	async function rebuild(force: boolean): Promise<void> {
		rebuilding = true;
		rebuildMessage = null;
		try {
			const result = await client.invoke.rebuild_reconstruction({
				project_id: projectId,
				force
			});
			commandReconstruction = result.reconstruction ?? null;
			// Invocations run outside this query object's local mutation path. The authoritative row
			// above makes the result visible immediately; refresh lets ordinary replica convergence
			// replace it without waiting for an unrelated render.
			void runsQuery.refresh();
			rebuildMessage =
				result.outcome === 'stitched'
					? 'Reconstruction rebuilt.'
					: result.outcome === 'skipped'
						? 'Inputs unchanged since the last run.'
						: 'The stitch failed — see the newest revision.';
		} catch (error) {
			rebuildMessage = error instanceof Error ? error.message : String(error);
		} finally {
			rebuilding = false;
		}
	}

	let saving = $state(false);
	let savedMessage = $state<string | null>(null);

	async function saveEstimate(levers: CostLevers): Promise<void> {
		if (!latestReady) return;
		saving = true;
		savedMessage = null;
		try {
			// Creation is policy-gated, so the client only exposes it when the
			// current scope may write estimates.
			const create = client.db.cost_estimates.create;
			if (!create) throw new Error('You do not have permission to create an estimate.');
			await create({
				estimate_name: `${record.project_name} — revision ${latestReady.revision}`,
				project_id: projectId,
				reconstruction_id: latestReady.norbital_id,
				status: 'draft',
				currency,
				sand_loss_pct: levers.sandLossPct,
				dredged_fill_loss_pct: levers.dredgedFillLossPct,
				perimeter_margin_pct: levers.perimeterMarginPct,
				pvd_area_fraction: levers.pvdAreaFraction,
				pvd_spacing_m: levers.pvdSpacingM,
				contingency_pct: levers.contingencyPct
			});
			savedMessage = 'Saved and re-priced server-side.';
		} catch (error) {
			savedMessage = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	function formatWhen(value: Date | string | null | undefined): string {
		if (!value) return 'not yet';
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}
</script>

{#snippet header()}
	<Stack as="header" gap="sm" class="border-b pb-3">
		<Cluster align="start" justify="between" gap="sm">
			<div class="min-w-0">
				<h2 class="truncate text-heading">{record.project_name}</h2>
				<p class="mt-0.5 truncate text-sm text-muted-foreground">
					{record.project_code ?? 'No project code'} · {record.client ?? 'No client'}
				</p>
			</div>
			<span class="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize">
				{record.status ?? 'no status'}
			</span>
		</Cluster>

		{#if !latestRun && !documentsReady}
			<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
				Attach all three reconstruction inputs to build the model. The stitch runs server-side as
				soon as the project is saved with a floor plan, a survey, and a section sheet.
			</p>
		{:else if !latestRun}
			<!--
				Attached but never stitched. A seed or an import writes straight to the
				database and triggers nothing, so a project can arrive complete and unbuilt.
				Saying "attach all three" here, next to three slots that all read
				`attached`, sends people looking for a missing document.
			-->
			<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
				All three inputs are attached and nothing has been stitched yet — press <strong
					>Build model</strong
				>. Saving the project stitches it automatically; rows written by a seed or an import bypass
				that, so they need one build.
			</p>
		{:else if latestRun.status === 'failed'}
			<div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
				<p class="font-medium text-destructive">
					Revision {latestRun.revision} did not produce a solid
				</p>
				<p class="mt-1 text-destructive/90">{latestRun.failure_reason}</p>
			</div>
		{/if}

		<Inline gap="sm" align="center" class="text-xs text-muted-foreground">
			<span>Datum {record.datum ?? 'CD'}</span>
			<span aria-hidden="true">·</span>
			<span>{record.interpolation ?? 'morph'} between sections</span>
			{#if latestRun}
				<span aria-hidden="true">·</span>
				<span>revision {latestRun.revision}, stitched {formatWhen(latestRun.stitched_at)}</span>
			{/if}
			{#if documentsReady}
				<Button size="sm" variant="outline" disabled={rebuilding} onclick={() => rebuild(false)}>
					{rebuilding ? 'Rebuilding…' : latestRun ? 'Rebuild' : 'Build model'}
				</Button>
				{#if latestRun}
					<Button size="sm" variant="ghost" disabled={rebuilding} onclick={() => rebuild(true)}>
						Force revision
					</Button>
				{/if}
			{/if}
			{#if rebuildMessage}
				<span>{rebuildMessage}</span>
			{/if}
		</Inline>
	</Stack>
{/snippet}

{#snippet documentsTab()}
	<Scroll name="Project documents" class="pr-1">
		<DocumentsPanel {projectId} {slots} provenance={report?.documents ?? []} />
	</Scroll>
{/snippet}

{#snippet modelTab()}
	<Scroll name="Model layers and checks" class="pr-1">
		{#if latestReady}
			<ModelPanel {layers} {visible} onToggle={toggleLayer} {stats} {metrics} {report} />
		{:else}
			<p class="p-3 text-sm text-muted-foreground">No successful reconstruction yet.</p>
		{/if}
	</Scroll>
{/snippet}

{#snippet sectionsTab()}
	<Scroll name="Sections as read" class="pr-1">
		{#if model}
			<SectionPanel {model} {report} />
		{:else}
			<p class="p-3 text-sm text-muted-foreground">Build the model to plot its sections.</p>
		{/if}
	</Scroll>
{/snippet}

{#snippet costTab()}
	<Scroll name="Cost simulation" class="pr-1">
		{#if latestReady && quantities.length > 0}
			<CostPanel
				{model}
				{quantities}
				{metrics}
				{rates}
				{currency}
				onSave={saveEstimate}
				{saving}
				{savedMessage}
			/>
		{:else}
			<p class="p-3 text-sm text-muted-foreground">
				Build the model first — the estimate prices the solid, not the drawings.
			</p>
		{/if}
	</Scroll>
{/snippet}

{#snippet leftPane()}
	<Stack gap="sm" fill>
		{@render header()}
		<!--
			`flex-1 min-h-0`, not the default `h-full`: this is a flex child sitting
			below the header, so a full-height tab body means header + 100% and the
			column overflows with nothing bounding it. The panels' own `Scroll` then
			grows to fit instead of scrolling, and anything past the fold — Save as
			estimate, the manual take-off register — is clipped and unreachable.
		-->
		<Tabs
			class="min-h-0 flex-1"
			lazyLoad={false}
			animate={false}
			config={[
				{
					name: 'documents',
					label: 'Documents',
					icon: 'lucide:folder-open',
					content: documentsTab
				},
				{ name: 'model', label: 'Model', icon: 'lucide:box', content: modelTab },
				{
					name: 'sections',
					label: 'Sections',
					icon: 'lucide:chart-spline',
					content: sectionsTab
				},
				{ name: 'cost', label: 'Cost', icon: 'lucide:calculator', content: costTab }
			] satisfies TabConfig[]}
		/>
	</Stack>
{/snippet}

{#snippet rightPane()}
	<Bound size="full" clip class="rounded-md border bg-muted/20">
		{#if model}
			<SiteDisplay
				{model}
				{visible}
				renderCellM={RENDER_CELL_M}
				{onLayers}
				onStats={(next) => (stats = next)}
				label={`${record.project_name} reconstruction`}
			/>
		{:else if runsQuery.loading}
			<div class="h-full w-full animate-pulse bg-muted/50"></div>
		{:else}
			<Inline
				align="center"
				justify="center"
				fill
				class="px-8 text-center text-sm text-muted-foreground"
			>
				No solid to show yet. Attach the floor plan, the bathymetric survey, and the section sheet;
				the reconstruction runs on save and the model appears when it lands.
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
		start={leftPane}
		end={rightPane}
	/>
</main>
