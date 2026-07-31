<script lang="ts">
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import InfoHint from './info-hint.svelte';
	import { cn } from '@norbital-ai/ui/utils';
	import { sampleSeabed } from '../../../lib/reclamation/math.js';
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
	 * The design surface is one line, not a point per label.
	 *
	 * A section sheet levels the finished profile at every change of grade and
	 * labels each of those points — toe, high water, crest, platform. They are
	 * not separate objects: joined in chainage order they *are* the drawn
	 * surface. Grouping by label instead left most layers holding a single point,
	 * which is why the plot showed dots and almost no lines.
	 *
	 * Anything below grade — a key trench, a rock blanket invert — is its own
	 * line, because it is a different surface at the same chainage.
	 */
	const surfaceLine = $derived(
		points
			.filter((point) => {
				const role = roleOf(point.layer);
				return role === 'surface' || role === 'toe' || role === 'platform';
			})
			.slice()
			.sort((a, b) => a.stationM - b.stationM)
	);

	const belowGradeLines = $derived.by(() => {
		const byLayer = new Map<string, ProfilePoint[]>();
		for (const point of points) {
			const role = roleOf(point.layer);
			if (role === 'surface' || role === 'toe' || role === 'platform') continue;
			const list = byLayer.get(point.layer) ?? [];
			list.push(point);
			byLayer.set(point.layer, list);
		}
		return [...byLayer.entries()].map(([layer, list]) => ({
			layer,
			points: list.slice().sort((a, b) => a.stationM - b.stationM)
		}));
	});

	/**
	 * The existing bed along this cut, sampled from the survey.
	 *
	 * A section without the ground it sits on cannot be checked against the
	 * drawing: the whole question is where the design meets the seabed. Sampled
	 * along the plan line of this cut where the floor plan gives one.
	 */
	const bedLine = $derived.by(() => {
		const cut = model.plan.sectionCuts?.find((entry) => entry.profileId === active);
		if (!cut || cut.line.length < 2 || surfaceLine.length === 0) return [];
		const [from, to] = [cut.line[0], cut.line[cut.line.length - 1]];
		const minS = surfaceLine[0].stationM;
		const maxS = surfaceLine[surfaceLine.length - 1].stationM;
		const steps = 80;
		const samples: { stationM: number; zCdM: number }[] = [];
		for (let index = 0; index <= steps; index++) {
			const t = index / steps;
			const x = from[0] + (to[0] - from[0]) * t;
			const y = from[1] + (to[1] - from[1]) * t;
			samples.push({ stationM: minS + (maxS - minS) * t, zCdM: sampleSeabed(model.seabed, x, y) });
		}
		return samples;
	});

	/**
	 * The substrate bands, constructed the way the engine measures them.
	 *
	 * A section sheet is layered — armour over geofabric over core, sand over
	 * dredged fill at the material change, a key trench under the toe. Drawing
	 * only the outline and the bed gives one solid body, which is exactly what
	 * the volumes are *not*: they are split by substrate, and this is where you
	 * check that the split is where the drawing puts it.
	 *
	 * Each band is derived from the same parameters the integrator uses, so a
	 * band drawn here and a quantity priced there cannot disagree.
	 */
	const bands = $derived.by(() => {
		if (surfaceLine.length < 2 || !extent) return [];
		const out: { id: string; label: string; color: string; opacity: number; path: string }[] = [];

		// Armour blanket: the design face, offset down by its own thickness measured
		// perpendicular to the slope, over the stretch the face actually occupies.
		const thickness = model.params.dimensionsM.armorThickness ?? 0;
		if (thickness > 0 && model.params.seawardFaceKind === 'revetment') {
			const face = surfaceLine.filter((point) => point.zCdM < model.params.levelsM.platform + 0.01);
			if (face.length >= 2) {
				const under = face.map((point, index) => {
					const previous = face[Math.max(0, index - 1)];
					const next = face[Math.min(face.length - 1, index + 1)];
					const run = next.stationM - previous.stationM;
					const rise = next.zCdM - previous.zCdM;
					// Vertical drop equivalent to a perpendicular thickness on this slope.
					const factor = run === 0 ? 1 : Math.hypot(run, rise) / Math.abs(run);
					return { stationM: point.stationM, zCdM: point.zCdM - thickness * factor };
				});
				out.push({
					id: 'armour',
					label: 'Rock armour',
					color: '#5c6470',
					opacity: 0.55,
					path: `M ${face.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' L ')} L ${[...under]
						.reverse()
						.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`)
						.join(' L ')} Z`
				});
			}
		}

		// Material change: sand above, dredged or excavated fill below.
		const interim = model.params.levelsM.interim;
		if (typeof interim === 'number' && bedLine.length > 1) {
			const clip = (z: number): number => Math.max(z, interim);
			out.push({
				id: 'sand_fill',
				label: 'Sand fill (above the material change)',
				color: '#d8c79a',
				opacity: 0.5,
				path: `M ${surfaceLine.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' L ')} L ${[
					...bedLine
				]
					.reverse()
					.map((p) => `${sx(p.stationM)},${sy(clip(p.zCdM))}`)
					.join(' L ')} Z`
			});
			out.push({
				id: 'dredged_fill',
				label: 'Dredged fill (below the material change)',
				color: '#a9946a',
				opacity: 0.5,
				path: `M ${bedLine.map((p) => `${sx(p.stationM)},${sy(clip(p.zCdM))}`).join(' L ')} L ${[
					...bedLine
				]
					.reverse()
					.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`)
					.join(' L ')} Z`
			});
		}

		return out;
	});

	const extent = $derived.by(() => {
		if (points.length === 0) return null;
		const stations = [...points.map((p) => p.stationM), ...bedLine.map((p) => p.stationM)];
		const levels = [...points.map((p) => p.zCdM), ...bedLine.map((p) => p.zCdM)];
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

	const W = 560;
	const H = 340;
	const PAD = { left: 46, right: 14, top: 14, bottom: 30 };

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
			<Inline align="center" gap="xs" class="border-b pb-2">
				<h3 class="text-sm font-semibold">Section as read</h3>
				<InfoHint
					text="Replotted from the rows the parser took out of the section sheet, against Chart Datum. Compare it with the drawing: a line at the wrong level, or a layer missing here, is an input the engine misread. The engine's interpolation between sections is deliberately not drawn."
				/>
			</Inline>

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

						<!-- The body, split by substrate the way the volumes are -->
						{#each bands as band (band.id)}
							<path d={band.path} fill={band.color} opacity={band.opacity}>
								<title>{band.label}</title>
							</path>
						{/each}
						{#if bands.length === 0 && bedLine.length > 1 && surfaceLine.length > 1}
							<!-- No material change given: one body is then the honest drawing. -->
							<path
								d={`M ${surfaceLine.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' L ')} L ${[
									...bedLine
								]
									.reverse()
									.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`)
									.join(' L ')} Z`}
								fill="currentColor"
								class="text-amber-700/20"
							/>
						{/if}
						{#if bedLine.length > 1}
							<polyline
								points={bedLine.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' ')}
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-dasharray="6 3"
								class="text-stone-500"
							/>
							<text
								x={sx(bedLine[bedLine.length - 1].stationM) - 4}
								y={sy(bedLine[bedLine.length - 1].zCdM) + 12}
								text-anchor="end"
								class="fill-stone-500 text-[9px]"
							>
								existing bed
							</text>
						{/if}

						<!-- Below-grade lines: trenches and blanket inverts -->
						{#each belowGradeLines as line (line.layer)}
							{#if line.points.length > 1}
								<polyline
									points={line.points.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' ')}
									fill="none"
									stroke={ROLE_COLOR[roleOf(line.layer)] ?? ROLE_COLOR.unclassified}
									stroke-width="3"
									stroke-linecap="round"
								/>
							{/if}
							{#each line.points as point, index (index)}
								<circle
									cx={sx(point.stationM)}
									cy={sy(point.zCdM)}
									r="3"
									fill={ROLE_COLOR[roleOf(line.layer)] ?? ROLE_COLOR.unclassified}
								>
									<title>{line.layer} · {fmt(point.stationM)} m · {fmt(point.zCdM, 2)} m CD</title>
								</circle>
							{/each}
						{/each}

						<!-- The design surface: one continuous profile, as drawn -->
						{#if surfaceLine.length > 1}
							<polyline
								points={surfaceLine.map((p) => `${sx(p.stationM)},${sy(p.zCdM)}`).join(' ')}
								fill="none"
								stroke="currentColor"
								stroke-width="2.6"
								stroke-linejoin="round"
								stroke-linecap="round"
								class="text-foreground"
							/>
						{/if}
						<!--
						No text at the points. Three levelled points inside twenty metres
						of chainage — crest_seaward, armor_crest, crest_landward — overlap
						into an unreadable smear at any plot width that fits a panel. The
						identity is on hover, in the legend, and in the table below.
					-->
						{#each surfaceLine as point, index (index)}
							<circle
								cx={sx(point.stationM)}
								cy={sy(point.zCdM)}
								r="3"
								fill={ROLE_COLOR[roleOf(point.layer)] ?? ROLE_COLOR.unclassified}
								stroke="currentColor"
								stroke-width="1"
								class="text-background"
							>
								<title>{point.layer} · {fmt(point.stationM)} m · {fmt(point.zCdM, 2)} m CD</title>
							</circle>
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
