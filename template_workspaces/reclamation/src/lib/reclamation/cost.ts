/**
 * Cost module: stitched quantities × the unit cost matrix.
 *
 * Quantities arrive from the solid and are not re-derived here. This file only
 * applies the commercial levers a quantity surveyor owns — placement loss,
 * perimeter margin, soil-improvement intensity, contingency — and multiplies by
 * the rate matrix.
 *
 * A measured substrate with no usable rate is an **error**, not a zero. An
 * estimate that quietly prices a material at nothing reads as complete when it
 * is not, so `buildEstimate` reports it and the server hook refuses the write.
 */

import { z } from 'zod';
import { MANUAL_TAKE_OFF, SUBSTRATES, substrateDefinition } from './substrates.js';
import type {
	QuantityUnit,
	ReconstructionMetrics,
	SubstrateId,
	SubstrateQuantity
} from './types.js';

export { MANUAL_TAKE_OFF, SUBSTRATES, substrateDefinition };
export type { ManualTakeOff, SubstrateDefinition } from './substrates.js';

/** Commercial levers held per project, all as plain percentages or metres. */
export type CostLevers = {
	/** Placement and washout loss added to sand fill (%). */
	readonly sandLossPct: number;
	/** Placement loss added to dredged and excavated fill (%). */
	readonly dredgedFillLossPct: number;
	/** Margin on perimeter-driven quantities for an uneven reclaim edge (%). */
	readonly perimeterMarginPct: number;
	/** Share of the platform receiving vertical drains (0–1). */
	readonly pvdAreaFraction: number;
	/** Triangular PVD grid spacing (m). */
	readonly pvdSpacingM: number;
	/** Contingency on the subtotal (%). */
	readonly contingencyPct: number;
};

export const DEFAULT_LEVERS: CostLevers = {
	sandLossPct: 8,
	dredgedFillLossPct: 5,
	perimeterMarginPct: 5,
	pvdAreaFraction: 0.4,
	pvdSpacingM: 1.5,
	contingencyPct: 10
};

export type RateRow = {
	readonly substrate: SubstrateId;
	readonly unit: QuantityUnit;
	readonly rate: number;
	readonly currency: string;
	readonly source?: string | null;
};

export type CostLine = {
	readonly substrate: SubstrateId;
	readonly label: string;
	readonly unit: QuantityUnit;
	/** Quantity as measured from the solid, before commercial levers. */
	readonly stitchedQuantity: number;
	/** Quantity actually priced, after loss and margin. */
	readonly pricedQuantity: number;
	readonly rate: number;
	readonly amount: number;
	readonly basis: string;
	readonly method: SubstrateQuantity['method'];
	/** True when this line has a measured quantity but no usable rate. */
	readonly unpriced: boolean;
};

export type CostEstimateResult = {
	readonly currency: string;
	readonly lines: readonly CostLine[];
	readonly subtotal: number;
	readonly contingency: number;
	readonly total: number;
	/**
	 * Substrates with a quantity but no usable rate. Non-empty means the total
	 * understates the works and the estimate must not be treated as complete.
	 */
	readonly unpricedSubstrates: readonly SubstrateId[];
	/** Rates that exist but in another currency, so they could not be applied. */
	readonly wrongCurrencySubstrates: readonly SubstrateId[];
};

function leverFor(levers: CostLevers, substrate: SubstrateId): { factor: number; note: string } {
	const definition = substrateDefinition(substrate);
	if (definition.driver === 'perimeter') {
		return {
			factor: 1 + levers.perimeterMarginPct / 100,
			note: `perimeter margin +${levers.perimeterMarginPct}%`
		};
	}
	if (substrate === 'sand_fill') {
		return { factor: 1 + levers.sandLossPct / 100, note: `placement loss +${levers.sandLossPct}%` };
	}
	if (substrate === 'dredged_fill') {
		return {
			factor: 1 + levers.dredgedFillLossPct / 100,
			note: `placement loss +${levers.dredgedFillLossPct}%`
		};
	}
	return { factor: 1, note: 'no loss applied' };
}

/**
 * PVD drain length for a triangular grid.
 *
 * `drains/m² = 2 / (√3 · s²)`, each driven to the mean fill depth. This is the
 * one priced quantity that is not a solid: the treated share of the platform and
 * the grid spacing are commercial choices, not drawn geometry.
 */
export function pvdLength(metrics: ReconstructionMetrics, levers: CostLevers): number {
	const spacing = Math.max(0.5, levers.pvdSpacingM);
	const treatedArea = metrics.platformAreaM2 * Math.max(0, Math.min(1, levers.pvdAreaFraction));
	const drainsPerSquareMetre = 2 / (Math.sqrt(3) * spacing * spacing);
	return treatedArea * drainsPerSquareMetre * Math.max(0, metrics.meanFillDepthM);
}

/** Price a stitched reconstruction. */
export function buildEstimate(input: {
	readonly quantities: readonly SubstrateQuantity[];
	readonly metrics: ReconstructionMetrics;
	readonly rates: readonly RateRow[];
	readonly levers: CostLevers;
	readonly currency: string;
}): CostEstimateResult {
	const usable = new Map(
		input.rates.filter((row) => row.currency === input.currency).map((row) => [row.substrate, row])
	);
	const otherCurrency = new Set(
		input.rates.filter((row) => row.currency !== input.currency).map((row) => row.substrate)
	);
	const measured = new Map(input.quantities.map((row) => [row.substrate, row]));

	const lines: CostLine[] = [];
	const unpricedSubstrates: SubstrateId[] = [];

	for (const definition of SUBSTRATES) {
		const stitched =
			definition.id === 'pvd'
				? {
						substrate: 'pvd' as const,
						unit: 'm' as const,
						quantity: pvdLength(input.metrics, input.levers),
						method: 'analytic' as const,
						basis: `${(input.levers.pvdAreaFraction * 100).toFixed(0)}% of the platform on a ${input.levers.pvdSpacingM} m triangular grid, ${input.metrics.meanFillDepthM.toFixed(2)} m mean depth`
					}
				: measured.get(definition.id);
		if (!stitched) continue;

		const rateRow = usable.get(definition.id);
		const { factor, note } = leverFor(input.levers, definition.id);
		const pricedQuantity = stitched.quantity * factor;
		const unpriced = rateRow === undefined && pricedQuantity > 0;
		if (unpriced) unpricedSubstrates.push(definition.id);

		lines.push({
			substrate: definition.id,
			label: definition.label,
			unit: definition.unit,
			stitchedQuantity: stitched.quantity,
			pricedQuantity,
			rate: rateRow?.rate ?? 0,
			amount: pricedQuantity * (rateRow?.rate ?? 0),
			basis: `${stitched.basis} · ${note}`,
			method: stitched.method,
			unpriced
		});
	}

	const subtotal = lines.reduce((total, line) => total + line.amount, 0);
	const contingency = subtotal * (Math.max(0, input.levers.contingencyPct) / 100);

	return {
		currency: input.currency,
		lines,
		subtotal,
		contingency,
		total: subtotal + contingency,
		unpricedSubstrates,
		wrongCurrencySubstrates: [...otherCurrency].filter((id) => unpricedSubstrates.includes(id))
	};
}

/** The message a caller shows, or throws, when the matrix is incomplete. */
export function unpricedMessage(result: CostEstimateResult): string | null {
	if (result.unpricedSubstrates.length === 0) return null;
	const names = result.unpricedSubstrates.map((id) => substrateDefinition(id).label).join(', ');
	const currencyNote =
		result.wrongCurrencySubstrates.length > 0
			? ` A rate exists for ${result.wrongCurrencySubstrates.map((id) => substrateDefinition(id).label).join(', ')} in another currency; this workspace holds no exchange rates, so it was not applied.`
			: '';
	return (
		`The cost matrix has no ${result.currency} rate for: ${names}. ` +
		`Those materials are measured but not priced, so the total understates the works.${currencyNote} ` +
		'Add the missing rates in the cost matrix and re-price.'
	);
}

export function formatQuantity(value: number, unit: QuantityUnit): string {
	const suffix = unit === 'm3' ? 'm³' : unit === 'm2' ? 'm²' : 'm';
	return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${suffix}`;
}

export function formatMoney(value: number, currency: string): string {
	if (!Number.isFinite(value)) return `— ${currency}`;
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency,
		maximumFractionDigits: 0
	}).format(value);
}

/**
 * The priced lines as stored on `cost_estimates.lines_json`, read back through validation the way
 * `reconstruction-json.ts` reads the stitch engine's blobs: `buildEstimate` writes them, and a cast
 * would only assert a stored blob still matches the engine that reads it. Absent, malformed or
 * off-contract JSON reads as no lines, which the panel already renders as "nothing priced yet".
 */
const costLine: z.ZodType<CostLine> = z.object({
	substrate: z.enum([
		'rock_armor',
		'geofabric',
		'dredged_rock',
		'sand_key',
		'sand_fill',
		'dredged_fill',
		'pvd'
	]),
	label: z.string(),
	unit: z.enum(['m3', 'm2', 'm']),
	stitchedQuantity: z.number(),
	pricedQuantity: z.number(),
	rate: z.number(),
	amount: z.number(),
	basis: z.string(),
	method: z.enum(['integrated', 'analytic']),
	unpriced: z.boolean()
});

/** Decode the stored priced lines of one estimate. */
export function parseCostLines(json: string | null | undefined): CostLine[] {
	if (typeof json !== 'string' || json.trim() === '') return [];
	try {
		const result = z.array(costLine).safeParse(JSON.parse(json));
		return result.success ? result.data : [];
	} catch {
		return [];
	}
}
