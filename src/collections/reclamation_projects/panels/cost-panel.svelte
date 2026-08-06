<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
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
		manualTakeOffLabel,
		manualTakeOffWhy,
		methodLabel,
		substrateLabel,
		substrateNote
	} from '../../../lib/reclamation/i18n.js';
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

	const i18n = useI18n<TenantI18nKeys>();
	const { t } = i18n;

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
	const incomplete = $derived(unpricedMessage(estimate, i18n));
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

	const DESIGN_CONTROLS = $derived([
		{
			key: 'platformOffsetM',
			label: t('component.control_platform_level'),
			note: t('component.control_platform_level_note'),
			min: -4,
			max: 4,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		},
		{
			key: 'bedOffsetM',
			label: t('component.control_bed_level'),
			note: t('component.control_bed_level_note'),
			min: -3,
			max: 3,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		},
		{
			key: 'faceRunFactor',
			label: t('component.control_face_batter'),
			note: t('component.control_face_batter_note'),
			min: 0.6,
			max: 1.6,
			step: 0.05,
			format: (v) => `×${v.toFixed(2)}`
		},
		{
			key: 'armorThicknessM',
			label: t('component.control_armour_thickness'),
			note: t('component.control_armour_thickness_note'),
			min: 0,
			max: 4,
			step: 0.1,
			format: (v) => (Number.isNaN(v) ? t('component.as_drawn_value') : `${v.toFixed(2)} m`)
		},
		{
			key: 'subGradeOffsetM',
			label: t('component.control_sub_grade'),
			note: t('component.control_sub_grade_note'),
			min: -3,
			max: 3,
			step: 0.1,
			format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`
		}
	] satisfies readonly {
		key: keyof GeometrySimulation;
		label: string;
		note: string;
		min: number;
		max: number;
		step: number;
		format: (value: number) => string;
	}[]);

	const COMMERCIAL_CONTROLS = $derived([
		{
			key: 'sandLossPct',
			label: t('component.control_sand_loss'),
			note: t('component.control_sand_loss_note'),
			min: 0,
			max: 30,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'dredgedFillLossPct',
			label: t('component.control_dredged_loss'),
			note: t('component.control_dredged_loss_note'),
			min: 0,
			max: 30,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'perimeterMarginPct',
			label: t('component.control_perimeter_margin'),
			note: t('component.control_perimeter_margin_note'),
			min: 0,
			max: 25,
			step: 0.5,
			format: (v) => `${v}%`
		},
		{
			key: 'pvdAreaFraction',
			label: t('component.control_pvd_area'),
			note: t('component.control_pvd_area_note'),
			min: 0,
			max: 1,
			step: 0.05,
			format: (v) => `${Math.round(v * 100)}%`
		},
		{
			key: 'pvdSpacingM',
			label: t('component.control_pvd_spacing'),
			note: t('component.control_pvd_spacing_note'),
			min: 0.8,
			max: 3,
			step: 0.1,
			format: (v) => `${v} m`
		},
		{
			key: 'contingencyPct',
			label: t('component.control_contingency'),
			note: t('component.control_contingency_note'),
			min: 0,
			max: 40,
			step: 1,
			format: (v) => `${v}%`
		}
	] satisfies readonly {
		key: keyof CostLevers;
		label: string;
		note: string;
		min: number;
		max: number;
		step: number;
		format: (value: number) => string;
	}[]);

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
				<h3 class="text-sm font-semibold">{t('component.design_simulation')}</h3>
				<p class="text-xs text-muted-foreground">{t('component.design_simulation_description')}</p>
			</div>
			<Button size="sm" variant="ghost" onclick={resetDesign}>{t('component.as_drawn')}</Button>
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
				{simulating ? t('component.remeasuring') : t('component.remeasure_volumes')}
			</Button>
			{#if simulated}
				<span class="text-xs tabular-nums text-muted-foreground">
					{t('component.volume_placed', { volume: number(activeVolume) })}
					<span class={activeVolume >= baseVolume ? 'text-amber-600' : 'text-brand'}>
						{t('component.pct_vs_as_drawn', {
							pct: `${activeVolume >= baseVolume ? '+' : ''}${number(
								((activeVolume - baseVolume) / Math.max(1, baseVolume)) * 100,
								1
							)}`
						})}
					</span>
				</span>
			{:else if !simulating}
				<span class="text-xs text-muted-foreground">{t('component.showing_as_drawn')}</span>
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
				<h3 class="text-sm font-semibold">{t('component.commercial_levers')}</h3>
				<InfoHint text={t('component.commercial_levers_hint')} />
			</Inline>
			<Button size="sm" variant="ghost" onclick={() => (levers = { ...DEFAULT_LEVERS })}>
				{t('component.reset')}
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
		<h3 class="border-b pb-2 text-sm font-semibold">{t('component.priced_lines')}</h3>
		<div class="divide-y rounded-md border bg-card text-sm">
			{#each estimate.lines as line (line.substrate)}
				<div class={line.unpriced ? 'bg-destructive/5 p-3' : 'p-3'}>
					<Inline align="start" justify="between" gap="sm">
						<Inline align="center" gap="xs" class="min-w-0">
							<p class="min-w-0 truncate font-medium">
								{substrateLabel(i18n, line.substrate, line.label)}
							</p>
							<InfoHint
								label={t('component.about_label', {
									label: substrateLabel(i18n, line.substrate, line.label)
								})}
								text={t('component.line_hint', {
									note: substrateNote(
										i18n,
										line.substrate,
										substrateDefinition(line.substrate).note
									),
									quantity: formatQuantity(line.stitchedQuantity, line.unit),
									method: line.method,
									basis: line.basis,
									result: line.unpriced
										? t('component.line_hint_unpriced', { currency })
										: t('component.line_hint_priced', {
												quantity: formatQuantity(line.pricedQuantity, line.unit),
												rate: formatMoney(line.rate, currency),
												amount: formatMoney(line.amount, currency)
											})
								})}
							/>
						</Inline>
						<p class="shrink-0 tabular-nums">
							{line.unpriced ? t('component.no_rate') : formatMoney(line.amount, currency)}
						</p>
					</Inline>
					<Inline justify="between" gap="sm" class="mt-1 text-xs text-muted-foreground">
						<span class="tabular-nums">
							{formatQuantity(line.pricedQuantity, line.unit)}
							{#if !line.unpriced}× {formatMoney(line.rate, currency)}{/if}
						</span>
						<span class="shrink-0">{methodLabel(i18n, line.method, line.method)}</span>
					</Inline>
					<p class="mt-1 text-xs text-muted-foreground">{line.basis}</p>
				</div>
			{/each}
		</div>

		<dl class="rounded-md border bg-card p-3 text-sm">
			<Inline as="div" justify="between" class="py-1">
				<dt>{t('component.subtotal')}</dt>
				<dd class="font-medium tabular-nums">{formatMoney(estimate.subtotal, currency)}</dd>
			</Inline>
			<Inline as="div" justify="between" class="py-1">
				<dt>{t('component.contingency')}</dt>
				<dd class="font-medium tabular-nums">{formatMoney(estimate.contingency, currency)}</dd>
			</Inline>
			<Inline as="div" justify="between" class="border-t pt-2">
				<dt class="font-medium">{t('component.total')}</dt>
				<dd class="text-heading tabular-nums">{formatMoney(estimate.total, currency)}</dd>
			</Inline>
		</dl>

		<Inline gap="sm" align="center">
			<Button size="sm" disabled={saving || incomplete !== null} onclick={() => onSave(levers)}>
				{saving ? t('component.saving') : t('component.save_as_estimate')}
			</Button>
			{#if savedMessage}
				<span class="text-xs text-muted-foreground">{savedMessage}</span>
			{/if}
		</Inline>
		<p class="text-xs text-muted-foreground">
			{t('component.saving_explainer')}
		</p>
	</Stack>

	<!-- What this estimate deliberately does not contain. -->
	<Stack as="section" gap="sm">
		<Inline align="center" gap="xs" class="border-b pb-2">
			<h3 class="text-sm font-semibold">{t('component.manual_take_off')}</h3>
			<InfoHint text={t('component.manual_take_off_hint')} />
		</Inline>
		<dl class="divide-y rounded-md border bg-card text-sm">
			{#each MANUAL_TAKE_OFF as item (item.id)}
				<Inline align="start" justify="between" gap="sm" class="p-3">
					<Inline align="center" gap="xs" class="min-w-0">
						<dt class="min-w-0 truncate font-medium">
							{manualTakeOffLabel(i18n, item.id, item.label)}
						</dt>
						<InfoHint
							label={t('component.why_label', {
								label: manualTakeOffLabel(i18n, item.id, item.label)
							})}
							text={manualTakeOffWhy(i18n, item.id, item.why)}
						/>
					</Inline>
					<dd class="shrink-0 text-xs text-muted-foreground">{item.unit}</dd>
				</Inline>
			{/each}
		</dl>
	</Stack>
</Stack>
