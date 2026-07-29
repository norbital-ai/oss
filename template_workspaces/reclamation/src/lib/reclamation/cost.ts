/**
 * Cost module: stitched quantities × the unit cost matrix.
 *
 * Quantities arrive from the solid and are not re-derived here. This file only
 * applies the commercial levers a quantity surveyor owns — placement loss,
 * perimeter margin, soil-improvement intensity, contingency — and multiplies by
 * the rate matrix.
 */

import type {
	QuantityUnit,
	ReconstructionMetrics,
	SubstrateId,
	SubstrateQuantity
} from './types.js';

export type SubstrateDefinition = {
	readonly id: SubstrateId;
	readonly label: string;
	readonly unit: QuantityUnit;
	/** Which lever family the quantity belongs to. */
	readonly driver: 'perimeter' | 'platform' | 'improvement';
	readonly note: string;
};

/** The priced substrate catalogue. A rate row exists per entry. */
export const SUBSTRATES: readonly SubstrateDefinition[] = [
	{
		id: 'rock_armor',
		label: 'Rock armour',
		unit: 'm3',
		driver: 'perimeter',
		note: 'Armour skin on the seaward face, integrated from the solid.'
	},
	{
		id: 'geofabric',
		label: 'Geofabric',
		unit: 'm2',
		driver: 'perimeter',
		note: 'One layer under the armour, 1:1 with the sloped face area.'
	},
	{
		id: 'dredged_rock',
		label: 'Dredged rock foundation',
		unit: 'm3',
		driver: 'perimeter',
		note: 'Foundation rock under the toe; prism, only when a thickness is stated.'
	},
	{
		id: 'sand_key',
		label: 'Sand key',
		unit: 'm3',
		driver: 'perimeter',
		note: 'Trench under the bund; prism from the section dimensions.'
	},
	{
		id: 'sand_fill',
		label: 'Sand fill',
		unit: 'm3',
		driver: 'platform',
		note: 'Bund sand plus platform fill above the material change level.'
	},
	{
		id: 'dredged_fill',
		label: 'Dredged and excavated fill',
		unit: 'm3',
		driver: 'platform',
		note: 'Platform fill below the material change level.'
	},
	{
		id: 'pvd',
		label: 'PVD soil improvement',
		unit: 'm',
		driver: 'improvement',
		note: 'Drain length from the treated area, grid spacing, and mean fill depth.'
	}
];

export function substrateDefinition(id: SubstrateId): SubstrateDefinition {
	const found = SUBSTRATES.find((entry) => entry.id === id);
	if (!found) throw new Error(`Unknown substrate "${id}".`);
	return found;
}

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
	/** Quantity as integrated from the solid, before commercial levers. */
	readonly stitchedQuantity: number;
	/** Quantity actually priced, after loss and margin. */
	readonly pricedQuantity: number;
	readonly rate: number;
	readonly amount: number;
	readonly basis: string;
	readonly method: SubstrateQuantity['method'];
};

export type CostEstimateResult = {
	readonly currency: string;
	readonly lines: readonly CostLine[];
	readonly subtotal: number;
	readonly contingency: number;
	readonly total: number;
	readonly missingRates: readonly SubstrateId[];
};

function leverFor(
	levers: CostLevers,
	definition: SubstrateDefinition,
	substrate: SubstrateId
): {
	factor: number;
	note: string;
} {
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
 * `drains/m² = 2 / (√3 · s²)`, each drain driven to the mean fill depth. This is
 * the one priced quantity that is not a solid: the treated share of the platform
 * and the grid spacing are commercial choices, not drawn geometry.
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
	const rateBySubstrate = new Map(input.rates.map((row) => [row.substrate, row]));
	const quantityBySubstrate = new Map(input.quantities.map((row) => [row.substrate, row]));

	const lines: CostLine[] = [];
	const missingRates: SubstrateId[] = [];

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
				: quantityBySubstrate.get(definition.id);
		if (!stitched) continue;

		const rateRow = rateBySubstrate.get(definition.id);
		if (!rateRow) missingRates.push(definition.id);
		const rate = rateRow?.rate ?? 0;
		const { factor, note } = leverFor(input.levers, definition, definition.id);
		const pricedQuantity = stitched.quantity * factor;

		lines.push({
			substrate: definition.id,
			label: definition.label,
			unit: definition.unit,
			stitchedQuantity: stitched.quantity,
			pricedQuantity,
			rate,
			amount: pricedQuantity * rate,
			basis: `${stitched.basis} · ${note}`,
			method: stitched.method
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
		missingRates
	};
}

export function formatQuantity(value: number, unit: QuantityUnit): string {
	const digits = unit === 'm2' || unit === 'm3' ? 0 : 0;
	return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${
		unit === 'm3' ? 'm³' : unit === 'm2' ? 'm²' : 'm'
	}`;
}

export function formatMoney(value: number, currency: string): string {
	if (!Number.isFinite(value)) return `— ${currency}`;
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency,
		maximumFractionDigits: 0
	}).format(value);
}
