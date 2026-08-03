<script lang="ts">
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import InfoHint from './info-hint.svelte';
	import type {
		ProfilePoint,
		StitchReport,
		StitchedModel
	} from '../../../lib/reclamation/types.js';

	/** Source check: only geometry decoded from the section drawing is shown here. */
	let { model, report }: { model: StitchedModel; report: StitchReport | null } = $props();
	const source = $derived(report?.documents.find((document) => document.kind === 'cross_section'));
	const drawingNative = $derived(source?.format === 'dxf' || source?.format === 'dwg');
	/**
	 * `dwg` stays in this test for revisions stitched before DWG was refused.
	 *
	 * No new revision can carry it — the model's MIME allowlist will not accept a
	 * DWG and `normalizeDrawing` refuses one before extraction — but a revision is
	 * never overwritten, so an older `report_json` still names that format. Its
	 * geometry did come from authored CAD entities, and dropping the test would
	 * relabel it "Legacy profile data" and tell the reader to replace a drawing
	 * that was read correctly.
	 */
	const archivedDwg = $derived(source?.format === 'dwg');

	const names = $derived(Object.keys(model.profiles).sort());
	let selected = $state<string | null>(null);
	const active = $derived(selected && model.profiles[selected] ? selected : (names[0] ?? null));
	const points = $derived<readonly ProfilePoint[]>(active ? (model.profiles[active] ?? []) : []);

	const roleOf = $derived((layer: string): string => {
		const overrides = model.classification?.layerOverrides;
		if (overrides?.toe?.includes(layer)) return 'toe';
		if (overrides?.surface?.includes(layer)) return 'surface';
		if (overrides?.internal?.includes(layer)) return 'internal';
		return model.classification?.layers.find((row) => row.layer === layer)?.role ?? 'unclassified';
	});

	const ROLE_COLOR: Record<string, string> = {
		toe: '#c2703d',
		surface: '#7f8c5c',
		platform: '#8a9a6b',
		internal: '#6b8fa8',
		unclassified: '#9aa0a6'
	};

	const segments = $derived.by(() => {
		const grouped = new Map<string, ProfilePoint[]>();
		for (const point of points) {
			const role = roleOf(point.layer);
			const legacyGroup = role === 'surface' || role === 'toe' ? 'legacy-surface' : point.layer;
			const key = point.segmentId ?? legacyGroup;
			const list = grouped.get(key) ?? [];
			list.push(point);
			grouped.set(key, list);
		}
		return [...grouped.entries()].map(([id, entries]) => ({
			id,
			points: entries.slice().sort((a, b) => a.stationM - b.stationM),
			role: roleOf(entries[0]?.layer ?? ''),
			layer: entries[0]?.layer ?? 'unclassified'
		}));
	});

	const extent = $derived.by(() => {
		if (points.length === 0) return null;
		const stations = points.map((point) => point.stationM);
		const levels = points.map((point) => point.zCdM);
		const minS = Math.min(...stations);
		const maxS = Math.max(...stations);
		const minZ = Math.min(...levels, 0);
		const maxZ = Math.max(...levels, 0);
		return {
			minS,
			maxS,
			minZ,
			maxZ,
			spanS: Math.max(1, maxS - minS),
			spanZ: Math.max(1, maxZ - minZ)
		};
	});

	const W = 720;
	const PAD = { left: 48, right: 16, top: 18, bottom: 34 };
	/** One drawing metre gets the same number of pixels on both axes. */
	const scale = $derived(extent ? (W - PAD.left - PAD.right) / extent.spanS : 1);
	const H = $derived(extent ? Math.max(112, PAD.top + PAD.bottom + extent.spanZ * scale) : 112);
	const drawingTop = $derived(extent ? (H - extent.spanZ * scale) / 2 : PAD.top);
	const sx = $derived((station: number): number =>
		extent ? PAD.left + (station - extent.minS) * scale : PAD.left
	);
	const sy = $derived((z: number): number =>
		extent ? drawingTop + (extent.maxZ - z) * scale : PAD.top
	);

	const zTicks = $derived.by(() => {
		if (!extent) return [];
		const step = extent.spanZ > 40 ? 10 : extent.spanZ > 16 ? 5 : extent.spanZ > 8 ? 2 : 1;
		const ticks: number[] = [];
		for (let z = Math.ceil(extent.minZ / step) * step; z <= extent.maxZ; z += step) ticks.push(z);
		return ticks;
	});
	const layerLegend = $derived([...new Set(points.map((point) => point.layer))]);

	function fmt(value: number, digits = 1): string {
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

<Stack gap="lg" class="pb-4">
	{#if names.length === 0}
		<p class="text-sm text-muted-foreground">No section geometry was decoded from the drawing.</p>
	{:else}
		<Stack as="section" gap="sm">
			<Inline align="center" gap="xs" class="border-b pb-2">
				<h3 class="text-sm font-semibold">
					{drawingNative ? 'Drawing geometry' : 'Legacy profile data'}
				</h3>
				<InfoHint
					text={drawingNative
						? 'Authored CAD entities only. Horizontal and vertical metres use one common scale; no bathymetry, material shading, or interpolated model geometry is added here.'
						: 'This reconstruction came from a legacy profile table, not a CAD drawing. It can be plotted at equal axis scale but cannot prove that drawing entities were identified correctly.'}
				/>
			</Inline>
			{#if !drawingNative}
				<p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
					Source is {source?.fileName ?? 'a non-CAD profile document'}. Replace it with the authored
					cross-section drawing before treating this reconstruction as verified.
				</p>
			{:else if archivedDwg}
				<p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
					This revision was stitched from a native DWG, which the reconstruction no longer reads.
					The geometry below stands, but rebuilding the project needs the same sheet exported to
					DXF.
				</p>
			{/if}

			{#if names.length > 1}
				<Cluster gap="xs" role="group" aria-label="Section">
					{#each names as name (name)}
						<button
							type="button"
							class={cn(
								'rounded-md border px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2',
								active === name ? 'border-brand bg-brand/10 font-medium' : 'hover:bg-muted/60'
							)}
							aria-pressed={active === name}
							onclick={() => (selected = name)}
						>
							{name}
						</button>
					{/each}
				</Cluster>
			{/if}

			{#if extent}
				<Scroll
					as="figure"
					axis="x"
					name={`Section ${active}`}
					class="rounded-md border bg-card p-2"
				>
					<svg
						viewBox={`0 0 ${W} ${H}`}
						class="block h-auto min-w-[36rem] w-full"
						role="img"
						aria-label={`Section ${active}, drawn with equal horizontal and vertical scale`}
					>
						{#each zTicks as z (z)}
							<line
								x1={PAD.left}
								x2={W - PAD.right}
								y1={sy(z)}
								y2={sy(z)}
								stroke="currentColor"
								stroke-width="0.5"
								class="text-muted-foreground/25"
							/>
							<text
								x={PAD.left - 6}
								y={sy(z) + 3}
								text-anchor="end"
								class="fill-muted-foreground text-[9px] tabular-nums"
							>
								{z}
							</text>
						{/each}

						<line
							x1={PAD.left}
							x2={W - PAD.right}
							y1={sy(0)}
							y2={sy(0)}
							stroke="currentColor"
							stroke-width="1"
							stroke-dasharray="4 3"
							class="text-sky-600"
						/>
						<text x={W - PAD.right} y={sy(0) - 4} text-anchor="end" class="fill-sky-600 text-[9px]"
							>CD 0.0</text
						>

						{#each segments as segment (segment.id)}
							{#if segment.points.length > 1}
								<polyline
									points={segment.points
										.map((point) => `${sx(point.stationM)},${sy(point.zCdM)}`)
										.join(' ')}
									fill="none"
									stroke={ROLE_COLOR[segment.role] ?? ROLE_COLOR.unclassified}
									stroke-width="2"
									vector-effect="non-scaling-stroke"
									stroke-linejoin="round"
								/>
							{/if}
							{#each segment.points as point, index (`${segment.id}-${index}`)}
								<circle
									cx={sx(point.stationM)}
									cy={sy(point.zCdM)}
									r="2.5"
									fill={ROLE_COLOR[segment.role] ?? ROLE_COLOR.unclassified}
								>
									<title>{point.layer} · {fmt(point.stationM)} m · {fmt(point.zCdM, 2)} m CD</title>
								</circle>
							{/each}
						{/each}

						<text x={PAD.left} y={H - 8} class="fill-muted-foreground text-[9px] tabular-nums"
							>{fmt(extent.minS)} m</text
						>
						<text
							x={W - PAD.right}
							y={H - 8}
							text-anchor="end"
							class="fill-muted-foreground text-[9px] tabular-nums">{fmt(extent.maxS)} m</text
						>
					</svg>
					<p class="mt-1 text-tiny text-muted-foreground tabular-nums">
						{points.length} decoded points · true scale (1:1 horizontal to vertical)
					</p>
				</Scroll>

				<Cluster as="ul" gap="md" class="text-xs">
					{#each layerLegend as layer (layer)}
						<Inline as="li" gap="xs">
							<span
								class="size-2.5 rounded-[2px]"
								style={`background:${ROLE_COLOR[roleOf(layer)] ?? ROLE_COLOR.unclassified}`}
							></span>
							<span class="truncate">{layer}</span>
						</Inline>
					{/each}
				</Cluster>
			{/if}
		</Stack>

		<Stack as="section" gap="sm">
			<h3 class="border-b pb-2 text-sm font-semibold">Decoded coordinates</h3>
			<Scroll axis="x" name="Decoded coordinates" class="rounded-md border bg-card">
				<table class="w-full text-xs">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th class="px-2 py-1.5 text-left font-medium">Layer</th>
							<th class="px-2 py-1.5 text-left font-medium">Role</th>
							<th class="px-2 py-1.5 text-right font-medium">Station m</th>
							<th class="px-2 py-1.5 text-right font-medium">Level m CD</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each points as point, index (index)}
							<tr>
								<td class="px-2 py-1 font-medium">{point.layer}</td>
								<td class="px-2 py-1 text-muted-foreground">{roleOf(point.layer)}</td>
								<td class="px-2 py-1 text-right tabular-nums">{fmt(point.stationM)}</td>
								<td class="px-2 py-1 text-right tabular-nums">{fmt(point.zCdM, 2)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</Scroll>
		</Stack>
	{/if}
</Stack>
