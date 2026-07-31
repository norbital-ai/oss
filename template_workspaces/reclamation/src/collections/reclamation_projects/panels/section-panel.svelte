<script lang="ts">
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import type { ProfilePoint, StitchedModel } from '../../../lib/reclamation/types.js';

	/**
	 * The section sheet, replotted from what the parser read.
	 *
	 * This is the check that the drawing and the solid agree. Every point here is
	 * a row the parser took out of the cross-section document — station, level,
	 * layer — drawn at true scale against Chart Datum. If a line sits at the wrong
	 * level, or a layer is missing, or a station reads as metres when the sheet
	 * says millimetres, it is visible here and nowhere else: the 3D view is too
	 * coarse to show a metre, and the volumes are already downstream of the error.
	 *
	 * Nothing is inferred. The engine's own interpolation between sections is
	 * deliberately not drawn, because the question this answers is whether the
	 * *input* was read correctly.
	 */
	let { model }: { model: StitchedModel } = $props();

	const names = $derived(Object.keys(model.profiles).sort());
	let selected = $state<string | null>(null);
	const active = $derived(selected && model.profiles[selected] ? selected : (names[0] ?? null));
	const points = $derived<readonly ProfilePoint[]>(active ? (model.profiles[active] ?? []) : []);

	/**
	 * Role decides the colour, so a section reads the same way as the solid.
	 *
	 * Overrides win: they are what the operator explicitly told the parser this
	 * layer means, and seeing that reflected here is the point of the check.
	 */
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
		subgrade: '#a8926b',
		structure: '#8d7fa8',
		unclassified: '#9aa0a6'
	};

	/**
	 * Points in file order, split into runs of one layer. A section sheet is a
	 * sequence of levelled points along a chainage, so consecutive points sharing
	 * a layer are one line; a change of layer starts another.
	 */
	const runs = $derived(
		points.reduce<{ layer: string; points: ProfilePoint[] }[]>((acc, point) => {
			const last = acc.at(-1);
			if (last && last.layer === point.layer) last.points.push(point);
			else acc.push({ layer: point.layer, points: [point] });
			return acc;
		}, [])
	);

	const extent = $derived.by(() => {
		if (points.length === 0) return null;
		const stations = points.map((p) => p.stationM);
		const levels = points.map((p) => p.zCdM);
		const minS = Math.min(...stations);
		const maxS = Math.max(...stations);
		const minZ = Math.min(...levels, 0);
		const maxZ = Math.max(...levels, 0);
		return {
			minS,
			maxS,
			minZ: minZ - 1,
			maxZ: maxZ + 1,
			spanS: Math.max(1, maxS - minS),
			spanZ: Math.max(1, maxZ - minZ + 2)
		};
	});

	const W = 520;
	const H = 260;
	const PAD = { left: 42, right: 12, top: 12, bottom: 28 };

	const sx = $derived((station: number): number =>
		extent
			? PAD.left + ((station - extent.minS) / extent.spanS) * (W - PAD.left - PAD.right)
			: PAD.left
	);
	const sy = $derived((z: number): number =>
		extent ? H - PAD.bottom - ((z - extent.minZ) / extent.spanZ) * (H - PAD.top - PAD.bottom) : 0
	);

	/** Round levels for the axis so the ticks land on numbers an engineer reads. */
	const zTicks = $derived.by(() => {
		if (!extent) return [];
		const step = extent.spanZ > 40 ? 10 : extent.spanZ > 16 ? 5 : extent.spanZ > 8 ? 2 : 1;
		const first = Math.ceil(extent.minZ / step) * step;
		const ticks: number[] = [];
		for (let z = first; z <= extent.maxZ; z += step) ticks.push(z);
		return ticks;
	});

	const layerLegend = $derived([...new Set(points.map((p) => p.layer))]);

	/** Vertical exaggeration this plot happens to be drawn at, stated honestly. */
	const drawnExaggeration = $derived.by(() => {
		if (!extent) return 1;
		const perMetreX = (W - PAD.left - PAD.right) / extent.spanS;
		const perMetreY = (H - PAD.top - PAD.bottom) / extent.spanZ;
		return perMetreY / perMetreX;
	});

	function fmt(value: number, digits = 1): string {
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

<Stack gap="lg" class="pb-4">
	{#if names.length === 0}
		<p class="text-sm text-muted-foreground">
			This reconstruction carries no section profiles, so there is nothing to check against.
		</p>
	{:else}
		<Stack as="section" gap="sm">
			<div class="border-b pb-2">
				<h3 class="text-sm font-semibold">Section as read</h3>
				<p class="text-xs text-muted-foreground">
					Replotted from the rows the parser took out of the section sheet, against Chart Datum.
					Compare it with the drawing: a line at the wrong level, or a layer that is missing here,
					is an input the engine misread.
				</p>
			</div>

			{#if names.length > 1}
				<div class="flex flex-wrap gap-1" role="group" aria-label="Section">
					{#each names as name (name)}
						<button
							type="button"
							class={cn(
								'rounded-md border px-2 py-1 text-xs',
								active === name ? 'border-brand bg-brand/10 font-medium' : 'hover:bg-muted/60'
							)}
							aria-pressed={active === name}
							onclick={() => (selected = name)}
						>
							{name}
						</button>
					{/each}
				</div>
			{/if}

			{#if extent}
				<figure class="rounded-md border bg-card p-2">
					<svg
						viewBox={`0 0 ${W} ${H}`}
						class="h-auto w-full"
						role="img"
						aria-label={`Section ${active} plotted against Chart Datum`}
					>
						<!-- Level grid -->
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

						<!-- Chart Datum: the reference every level on the sheet is signed against -->
						<line
							x1={PAD.left}
							x2={W - PAD.right}
							y1={sy(0)}
							y2={sy(0)}
							stroke="currentColor"
							stroke-width="1.2"
							stroke-dasharray="4 3"
							class="text-sky-600"
						/>
						<text x={W - PAD.right} y={sy(0) - 4} text-anchor="end" class="fill-sky-600 text-[9px]">
							CD 0.0
						</text>

						<!-- Station axis -->
						<line
							x1={PAD.left}
							x2={W - PAD.right}
							y1={H - PAD.bottom}
							y2={H - PAD.bottom}
							stroke="currentColor"
							stroke-width="0.8"
							class="text-muted-foreground/50"
						/>
						<text
							x={PAD.left}
							y={H - PAD.bottom + 14}
							class="fill-muted-foreground text-[9px] tabular-nums"
						>
							{fmt(extent.minS)} m
						</text>
						<text
							x={W - PAD.right}
							y={H - PAD.bottom + 14}
							text-anchor="end"
							class="fill-muted-foreground text-[9px] tabular-nums"
						>
							{fmt(extent.maxS)} m
						</text>

						<!-- The drawn layers -->
						{#each runs as run, index (index)}
							{#if run.points.length > 1}
								<polyline
									points={run.points.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' ')}
									fill="none"
									stroke={ROLE_COLOR[roleOf(run.layer)] ?? ROLE_COLOR.unclassified}
									stroke-width="2"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							{/if}
							{#each run.points as point, pointIndex (pointIndex)}
								<circle
									cx={sx(point.stationM)}
									cy={sy(point.zCdM)}
									r="2.4"
									fill={ROLE_COLOR[roleOf(run.layer)] ?? ROLE_COLOR.unclassified}
								>
									<title>
										{run.layer} · station {fmt(point.stationM)} m · {fmt(point.zCdM, 2)} m CD
									</title>
								</circle>
							{/each}
						{/each}
					</svg>
					<figcaption class="mt-1 text-tiny text-muted-foreground tabular-nums">
						{points.length} levelled points · heights ×{fmt(drawnExaggeration)} against chainage
					</figcaption>
				</figure>

				<ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
					{#each layerLegend as layer (layer)}
						<li class="flex items-center gap-1.5">
							<span
								class="size-2.5 rounded-[2px]"
								style={`background:${ROLE_COLOR[roleOf(layer)] ?? ROLE_COLOR.unclassified}`}
							></span>
							<span class="truncate">{layer}</span>
							<span class="text-muted-foreground">{roleOf(layer)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Stack>

		<Stack as="section" gap="sm">
			<h3 class="border-b pb-2 text-sm font-semibold">Levelled points</h3>
			<div class="overflow-x-auto rounded-md border bg-card">
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
			</div>
		</Stack>
	{/if}
</Stack>
