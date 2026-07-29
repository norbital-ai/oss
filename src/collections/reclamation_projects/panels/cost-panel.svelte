<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import {
		DEFAULT_LEVERS,
		buildEstimate,
		formatMoney,
		formatQuantity,
		type CostLevers,
		type RateRow
	} from '../../../lib/reclamation/cost.js';
	import type { ReconstructionMetrics, SubstrateQuantity } from '../../../lib/reclamation/types.js';

	/**
	 * Live cost simulation.
	 *
	 * The levers recompute in the browser against the *same* engine the server
	 * uses, so moving a slider answers immediately and cannot disagree with what
	 * a saved estimate would produce. Nothing is written until the estimate is
	 * saved, so exploring an option costs nothing.
	 */
	let {
		quantities,
		metrics,
		rates,
		currency,
		onSave,
		saving = false,
		savedMessage = null
	}: {
		quantities: readonly SubstrateQuantity[];
		metrics: ReconstructionMetrics;
		rates: readonly RateRow[];
		currency: string;
		onSave: (levers: CostLevers) => void;
		saving?: boolean;
		savedMessage?: string | null;
	} = $props();

	let levers = $state<CostLevers>({ ...DEFAULT_LEVERS });

	const estimate = $derived(buildEstimate({ quantities, metrics, rates, levers, currency }));

	const CONTROLS: readonly {
		key: keyof CostLevers;
		label: string;
		note: string;
		min: number;
		max: number;
		step: number;
		suffix: string;
	}[] = [
		{
			key: 'sandLossPct',
			label: 'Sand placement loss',
			note: 'Washout and bulking on hydraulic placement.',
			min: 0,
			max: 30,
			step: 0.5,
			suffix: '%'
		},
		{
			key: 'dredgedFillLossPct',
			label: 'Dredged fill loss',
			note: 'Placement loss on dredged and excavated material.',
			min: 0,
			max: 30,
			step: 0.5,
			suffix: '%'
		},
		{
			key: 'perimeterMarginPct',
			label: 'Perimeter margin',
			note: 'Allowance for an uneven reclaim edge, on every perimeter line.',
			min: 0,
			max: 25,
			step: 0.5,
			suffix: '%'
		},
		{
			key: 'pvdAreaFraction',
			label: 'PVD treated area',
			note: 'Share of the platform receiving vertical drains.',
			min: 0,
			max: 1,
			step: 0.05,
			suffix: ''
		},
		{
			key: 'pvdSpacingM',
			label: 'PVD spacing',
			note: 'Triangular grid pitch. Drain count scales with 1/s².',
			min: 0.8,
			max: 3,
			step: 0.1,
			suffix: ' m'
		},
		{
			key: 'contingencyPct',
			label: 'Contingency',
			note: 'Applied to the subtotal.',
			min: 0,
			max: 40,
			step: 1,
			suffix: '%'
		}
	];

	function set(key: keyof CostLevers, value: number): void {
		levers = { ...levers, [key]: value };
	}

	function reset(): void {
		levers = { ...DEFAULT_LEVERS };
	}

	function format(key: keyof CostLevers, suffix: string): string {
		const value = levers[key];
		return key === 'pvdAreaFraction' ? `${Math.round(value * 100)}%` : `${value}${suffix}`;
	}
</script>

<Stack gap="lg" class="pb-4">
	<Stack as="section" gap="sm">
		<Inline justify="between" align="center" gap="sm" class="border-b pb-2">
			<div class="min-w-0">
				<h3 class="text-sm font-semibold">Cost simulation</h3>
				<p class="text-xs text-muted-foreground">
					Quantities are fixed by the solid. These are the commercial levers.
				</p>
			</div>
			<Button size="sm" variant="ghost" onclick={reset}>Reset</Button>
		</Inline>

		<Stack gap="md">
			{#each CONTROLS as control (control.key)}
				<div>
					<Inline justify="between" align="baseline" gap="sm">
						<label class="text-sm font-medium" for={`lever-${control.key}`}>
							{control.label}
						</label>
						<span class="text-sm tabular-nums">{format(control.key, control.suffix)}</span>
					</Inline>
					<input
						id={`lever-${control.key}`}
						type="range"
						class="mt-1 w-full accent-brand"
						min={control.min}
						max={control.max}
						step={control.step}
						value={levers[control.key]}
						oninput={(event) => set(control.key, Number(event.currentTarget.value))}
					/>
					<p class="text-xs text-muted-foreground">{control.note}</p>
				</div>
			{/each}
		</Stack>
	</Stack>

	<Stack as="section" gap="sm">
		<h3 class="border-b pb-2 text-sm font-semibold">Priced lines</h3>
		<div class="divide-y rounded-md border bg-card text-sm">
			{#each estimate.lines as line (line.substrate)}
				<div class="p-3">
					<Inline align="start" justify="between" gap="sm">
						<p class="min-w-0 truncate font-medium">{line.label}</p>
						<p class="shrink-0 tabular-nums">{formatMoney(line.amount, currency)}</p>
					</Inline>
					<Inline justify="between" gap="sm" class="mt-1 text-xs text-muted-foreground">
						<span class="tabular-nums">
							{formatQuantity(line.pricedQuantity, line.unit)} × {formatMoney(line.rate, currency)}
							{#if Math.abs(line.pricedQuantity - line.stitchedQuantity) > 0.5}
								<span class="ml-1">
									(from {formatQuantity(line.stitchedQuantity, line.unit)})
								</span>
							{/if}
						</span>
						<span class="shrink-0 capitalize">{line.method}</span>
					</Inline>
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

		{#if estimate.missingRates.length > 0}
			<p class="text-xs text-destructive">
				No {currency} rate for: {estimate.missingRates.join(', ')}. Those lines price at zero — add
				them in the cost matrix.
			</p>
		{/if}

		<Inline gap="sm" align="center">
			<Button size="sm" disabled={saving} onclick={() => onSave(levers)}>
				{saving ? 'Saving…' : 'Save as estimate'}
			</Button>
			{#if savedMessage}
				<span class="text-xs text-muted-foreground">{savedMessage}</span>
			{/if}
		</Inline>
		<p class="text-xs text-muted-foreground">
			Simulating changes nothing. Saving writes a `cost_estimates` record against this
			reconstruction revision, re-priced server-side from the same levers.
		</p>
	</Stack>
</Stack>
