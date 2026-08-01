<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import InfoHint from './info-hint.svelte';
	import {
		DEFAULT_LEVERS,
		MANUAL_TAKE_OFF,
		buildEstimate,
		formatMoney,
		formatQuantity,
		substrateDefinition,
		unpricedMessage,
		type CostLevers,
		type RateRow
	} from '../../../lib/reclamation/cost.js';
	import {
		baseSimulation,
		isIdentity,
		type GeometrySimulation
	} from '../../../lib/reclamation/simulation.js';
	import { simulate } from '../../../lib/site-viewer/geometry-worker.js';
	import type {
		ReconstructionMetrics,
		StitchedModel,
		SubstrateQuantity
	} from '../../../lib/reclamation/types.js';

	/**
	 * Cost simulation, in two halves.
	 *
	 * **Design levers** change the solid. Moving one re-integrates the model in
	 * the worker, through the same engine the server used, and the quantities
	 * that come back are the volumes of a real alternative design — not a factor
	 * applied to the base case.
	 *
	 * **Commercial levers** change only what is priced, and recompute instantly.
	 *
	 * Nothing is written until the estimate is saved.
	 */
	let {
		model,
		quantities,
		metrics,
		rates,
		currency,
		onSave,
		saving = false,
		savedMessage = null
	}: {
		model: StitchedModel | null;
		quantities: readonly SubstrateQuantity[];
		metrics: ReconstructionMetrics;
		rates: readonly RateRow[];
		currency: string;
		onSave: (levers: CostLevers) => void;
		saving?: boolean;
		savedMessage?: string | null;
	} = $props();

	let levers = $state<CostLevers>({ ...DEFAULT_LEVERS });
	// svelte-ignore state_referenced_locally -- reset explicitly when the model changes.
	let design = $state<GeometrySimulation>(
		model
			? baseSimulation(model)
			: {
					bedOffsetM: 0,
					platformOffsetM: 0,
					faceRunFactor: 1,
					armorThicknessM: Number.NaN,
					subGradeOffsetM: 0
				}
	);
	let simulated = $state<{
		quantities: readonly SubstrateQuantity[];
		metrics: ReconstructionMetrics;
	} | null>(null);
	let simulating = $state(false);
	let simulationError = $state<string | null>(null);

	const activeQuantities = $derived(simulated?.quantities ?? quantities);
	const activeMetrics = $derived(simulated?.metrics ?? metrics);
	const estimate = $derived(
		buildEstimate({ quantities: activeQuantities, metrics: activeMetrics, rates, levers, currency })
	);
	const incomplete = $derived(unpricedMessage(estimate));
	const baseVolume = $derived(metrics.placedVolumeM3);
	const activeVolume = $derived(activeMetrics.placedVolumeM3);

	async function runSimulation(): Promise<void> {
		if (!model) return;
		simulating = true;
		simulationError = null;
		try {
			simulated = isIdentity(design) ? null : await simulate(model, design);
		} catch (error) {
			simulationError = error instanceof Error ? error.message : String(error);
		} finally {
			simulating = false;
		}
	}

	function resetDesign(): void {
		if (model) design = baseSimulation(model);
		simulated = null;
		simulationError = null;
	}

	const DESIGN_CONTROLS: readonly {
		key: keyof GeometrySimulation;
		label: string;
		note: string;
		min: number;
		max: number;
		step: number;
		format: (value: number) => string;
	}[] = [
		{
			key: 'platformOffsetM',
			label: 'Platform level',
			note: 'Raise or lower the whole works. Every slope and width is preserved.',
			min: -4,
			max: 4,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		},
		{
			key: 'bedOffsetM',
			label: 'Bed level',
			note: 'Survey tolerance, post-dredge level, or settlement under the fill.',
			min: -3,
			max: 3,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		},
		{
			key: 'faceRunFactor',
			label: 'Face batter',
			note: 'Widen or steepen the seaward face; the platform keeps its width.',
			min: 0.6,
			max: 1.6,
			step: 0.05,
			format: (v) => `×${v.toFixed(2)}`
		},
		{
			key: 'armorThicknessM',
			label: 'Armour thickness',
			note: 'Perpendicular to the face. Scales armour and geofabric directly.',
			min: 0,
			max: 4,
			step: 0.1,
			format: (v) => (Number.isNaN(v) ? 'as drawn' : `${v.toFixed(2)} m`)
		},
		{
			key: 'subGradeOffsetM',
			label: 'Sub-grade inverts',
			note: 'Deepen or raise every trench drawn on the section.',
			min: -3,
			max: 3,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		}
	];

	const COMMERCIAL_CONTROLS: readonly {
		key: keyof CostLevers;
		label: string;
		note: string;
		min: number;
		max: number;
		step: number;
		format: (value: number) => string;
	}[] = [
		{
			key: 'sandLossPct',
			label: 'Sand placement loss',
			note: 'Washout and bulking on hydraulic placement.',
			min: 0,
			max: 30,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'dredgedFillLossPct',
			label: 'Dredged fill loss',
			note: 'Placement loss on dredged and excavated material.',
			min: 0,
			max: 30,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'perimeterMarginPct',
			label: 'Perimeter margin',
			note: 'Allowance for an uneven reclaim edge, on every perimeter line.',
			min: 0,
			max: 25,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'pvdAreaFraction',
			label: 'PVD treated area',
			note: 'Share of the platform receiving vertical drains.',
			min: 0,
			max: 1,
			step: 0.05,
			format: (v) => `${Math.round(v * 100)}%`
		},
		{
			key: 'pvdSpacingM',
			label: 'PVD spacing',
			note: 'Triangular grid pitch. Drain count scales with 1/s².',
			min: 0.8,
			max: 3,
			step: 0.1,
			format: (v) => `${v} m`
		},
		{
			key: 'contingencyPct',
			label: 'Contingency',
			note: 'Applied to the subtotal.',
			min: 0,
			max: 40,
			step: 1,
			format: (v) => `${v}%`
		}
	];

	function number(value: number, digits = 0): string {
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

<Stack gap="lg" class="pb-4">
	{#if incomplete}
		<p
			class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
			role="alert"
		>
			{incomplete}
		</p>
	{/if}

	<!-- Design levers: these change the solid, so they re-integrate. -->
	<Stack as="section" gap="sm">
		<Inline justify="between" align="center" gap="sm" class="border-b pb-2">
			<div class="min-w-0">
				<h3 class="text-sm font-semibold">Design simulation</h3>
				<p class="text-xs text-muted-foreground">Changes the solid, then re-measures it.</p>
			</div>
			<Button size="sm" variant="ghost" onclick={resetDesign}>As drawn</Button>
		</Inline>

		{#each DESIGN_CONTROLS as control (control.key)}
			<div>
				<Inline justify="between" align="baseline" gap="sm">
					<label class="text-sm font-medium" for={`design-${control.key}`}>{control.label}</label>
					<span class="text-sm tabular-nums">{control.format(design[control.key])}</span>
				</Inline>
				<input
					id={`design-${control.key}`}
					type="range"
					class="mt-1 w-full accent-brand"
					min={control.min}
					max={control.max}
					step={control.step}
					value={Number.isNaN(design[control.key]) ? control.min : design[control.key]}
					oninput={(event) =>
						(design = { ...design, [control.key]: Number(event.currentTarget.value) })}
				/>
				<p class="text-xs text-muted-foreground">{control.note}</p>
			</div>
		{/each}

		<Inline gap="sm" align="center">
			<Button size="sm" variant="outline" disabled={simulating || !model} onclick={runSimulation}>
				{simulating ? 'Re-measuring…' : 'Re-measure volumes'}
			</Button>
			{#if simulated}
				<span class="text-xs tabular-nums text-muted-foreground">
					{number(activeVolume)} m³ placed
					<span class={activeVolume >= baseVolume ? 'text-amber-600' : 'text-brand'}>
						({activeVolume >= baseVolume ? '+' : ''}{number(
							((activeVolume - baseVolume) / Math.max(1, baseVolume)) * 100,
							1
						)}% vs as drawn)
					</span>
				</span>
			{:else if !simulating}
				<span class="text-xs text-muted-foreground">Showing the design as drawn.</span>
			{/if}
		</Inline>
		{#if simulationError}
			<p class="text-xs text-destructive">{simulationError}</p>
		{/if}
	</Stack>

	<!-- Commercial levers: these change only what is priced. -->
	<Stack as="section" gap="sm">
		<Inline justify="between" align="center" gap="sm" class="border-b pb-2">
			<Inline align="center" gap="xs" class="min-w-0">
				<h3 class="text-sm font-semibold">Commercial levers</h3>
				<InfoHint
					text="These change only what is priced, and recompute instantly. The solid does not move, so the measured quantities are untouched."
				/>
			</Inline>
			<Button size="sm" variant="ghost" onclick={() => (levers = { ...DEFAULT_LEVERS })}>
				Reset
			</Button>
		</Inline>

		{#each COMMERCIAL_CONTROLS as control (control.key)}
			<div>
				<Inline justify="between" align="baseline" gap="sm">
					<label class="text-sm font-medium" for={`lever-${control.key}`}>{control.label}</label>
					<span class="text-sm tabular-nums">{control.format(levers[control.key])}</span>
				</Inline>
				<input
					id={`lever-${control.key}`}
					type="range"
					class="mt-1 w-full accent-brand"
					min={control.min}
					max={control.max}
					step={control.step}
					value={levers[control.key]}
					oninput={(event) =>
						(levers = { ...levers, [control.key]: Number(event.currentTarget.value) })}
				/>
				<p class="text-xs text-muted-foreground">{control.note}</p>
			</div>
		{/each}
	</Stack>

	<Stack as="section" gap="sm">
		<h3 class="border-b pb-2 text-sm font-semibold">Priced lines</h3>
		<div class="divide-y rounded-md border bg-card text-sm">
			{#each estimate.lines as line (line.substrate)}
				<div class={line.unpriced ? 'bg-destructive/5 p-3' : 'p-3'}>
					<Inline align="start" justify="between" gap="sm">
						<Inline align="center" gap="xs" class="min-w-0">
							<p class="min-w-0 truncate font-medium">{line.label}</p>
							<InfoHint
								label={`About ${line.label}`}
								text={`${substrateDefinition(line.substrate).note} — Measured ${formatQuantity(line.stitchedQuantity, line.unit)} by ${line.method}. ${line.basis}. ${
									line.unpriced
										? `No ${currency} rate in the cost matrix, so this line cannot be priced.`
										: `Priced ${formatQuantity(line.pricedQuantity, line.unit)} × ${formatMoney(line.rate, currency)} = ${formatMoney(line.amount, currency)}.`
								}`}
							/>
						</Inline>
						<p class="shrink-0 tabular-nums">
							{line.unpriced ? 'no rate' : formatMoney(line.amount, currency)}
						</p>
					</Inline>
					<Inline justify="between" gap="sm" class="mt-1 text-xs text-muted-foreground">
						<span class="tabular-nums">
							{formatQuantity(line.pricedQuantity, line.unit)}
							{#if !line.unpriced}× {formatMoney(line.rate, currency)}{/if}
						</span>
						<span class="shrink-0 capitalize">{line.method}</span>
					</Inline>
					<p class="mt-1 text-xs text-muted-foreground">{line.basis}</p>
				</div>
			{/each}
		</div>

		<dl class="rounded-md border bg-card p-3 text-sm">
			<Inline as="div" justify="between" class="py-1">
				<dt>Subtotal</dt>
				<dd class="font-medium tabular-nums">{formatMoney(estimate.subtotal, currency)}</dd>
			</Inline>
			<Inline as="div" justify="between" class="py-1">
				<dt>Contingency</dt>
				<dd class="font-medium tabular-nums">{formatMoney(estimate.contingency, currency)}</dd>
			</Inline>
			<Inline as="div" justify="between" class="border-t pt-2">
				<dt class="font-medium">Total</dt>
				<dd class="text-heading tabular-nums">{formatMoney(estimate.total, currency)}</dd>
			</Inline>
		</dl>

		<Inline gap="sm" align="center">
			<Button size="sm" disabled={saving || incomplete !== null} onclick={() => onSave(levers)}>
				{saving ? 'Saving…' : 'Save as estimate'}
			</Button>
			{#if savedMessage}
				<span class="text-xs text-muted-foreground">{savedMessage}</span>
			{/if}
		</Inline>
		<p class="text-xs text-muted-foreground">
			Saving records the commercial levers against this reconstruction revision and re-prices
			server-side. A design simulation is exploratory: to keep it, change the project and re-stitch.
		</p>
	</Stack>

	<!-- What this estimate deliberately does not contain. -->
	<Stack as="section" gap="sm">
		<Inline align="center" gap="xs" class="border-b pb-2">
			<h3 class="text-sm font-semibold">Priced separately — manual take-off</h3>
			<InfoHint
				text="Work a plan, a survey, and a section do not contain — the rate depends on method, material, or a structural drawing rather than on shape. The total above excludes all of it."
			/>
		</Inline>
		<dl class="divide-y rounded-md border bg-card text-sm">
			{#each MANUAL_TAKE_OFF as item (item.id)}
				<Inline align="start" justify="between" gap="sm" class="p-3">
					<Inline align="center" gap="xs" class="min-w-0">
						<dt class="min-w-0 truncate font-medium">{item.label}</dt>
						<InfoHint label={`Why ${item.label} is manual`} text={item.why} />
					</Inline>
					<dd class="shrink-0 text-xs text-muted-foreground">{item.unit}</dd>
				</Inline>
			{/each}
		</dl>
	</Stack>
</Stack>
