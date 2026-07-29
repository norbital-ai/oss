/**
 * Pricing driver for `cost_estimates`.
 *
 * Quantities are read back from the reconstruction revision, never recomputed:
 * an estimate is a commercial view of one specific solid, and re-deriving the
 * geometry here would let the two drift.
 */

import {
	buildEstimate,
	DEFAULT_LEVERS,
	type CostLevers,
	type RateRow
} from '../../../lib/reclamation/cost.js';
import type {
	ReconstructionMetrics,
	SubstrateId,
	SubstrateQuantity
} from '../../../lib/reclamation/types.js';

export type ReconstructionRow = {
	readonly norbital_id: string;
	readonly status?: string | null;
	readonly quantities_json?: string | null;
	readonly platform_area_m2?: number | null;
	readonly works_footprint_m2?: number | null;
	readonly armor_face_area_m2?: number | null;
	readonly shoreline_length_m?: number | null;
	readonly mean_fill_depth_m?: number | null;
	readonly max_fill_depth_m?: number | null;
	readonly integration_cell_m?: number | null;
	readonly structure_displacement_m3?: number | null;
	readonly excavation_m3?: number | null;
	readonly placed_volume_m3?: number | null;
};

export type RateRecord = {
	readonly substrate?: string | null;
	readonly unit?: string | null;
	readonly rate?: { value?: number; currency?: string } | null;
};

export type EstimateInput = {
	readonly project_id?: string | null;
	readonly reconstruction_id?: string | null;
	readonly currency?: string | null;
	readonly sand_loss_pct?: number | null;
	readonly dredged_fill_loss_pct?: number | null;
	readonly perimeter_margin_pct?: number | null;
	readonly pvd_area_fraction?: number | null;
	readonly pvd_spacing_m?: number | null;
	readonly contingency_pct?: number | null;
};

export type PricedEstimate = {
	readonly reconstruction_id: string;
	readonly currency: string;
	readonly subtotal: { value: number; currency: string };
	readonly contingency: { value: number; currency: string };
	readonly total: { value: number; currency: string };
	readonly lines_json: string;
	readonly missing_rates: string[];
	readonly priced_at: string;
};

function number(value: number | null | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function leversFrom(input: EstimateInput): CostLevers {
	return {
		sandLossPct: number(input.sand_loss_pct, DEFAULT_LEVERS.sandLossPct),
		dredgedFillLossPct: number(input.dredged_fill_loss_pct, DEFAULT_LEVERS.dredgedFillLossPct),
		perimeterMarginPct: number(input.perimeter_margin_pct, DEFAULT_LEVERS.perimeterMarginPct),
		pvdAreaFraction: number(input.pvd_area_fraction, DEFAULT_LEVERS.pvdAreaFraction),
		pvdSpacingM: number(input.pvd_spacing_m, DEFAULT_LEVERS.pvdSpacingM),
		contingencyPct: number(input.contingency_pct, DEFAULT_LEVERS.contingencyPct)
	};
}

export function metricsFrom(row: ReconstructionRow): ReconstructionMetrics {
	return {
		platformAreaM2: number(row.platform_area_m2, 0),
		worksFootprintM2: number(row.works_footprint_m2, 0),
		armorFaceAreaM2: number(row.armor_face_area_m2, 0),
		shorelineLengthM: number(row.shoreline_length_m, 0),
		meanFillDepthM: number(row.mean_fill_depth_m, 0),
		maxFillDepthM: number(row.max_fill_depth_m, 0),
		integratedCells: 0,
		integrationCellM: number(row.integration_cell_m, 0),
		structureDisplacementM3: number(row.structure_displacement_m3, 0),
		excavationM3: number(row.excavation_m3, 0),
		placedVolumeM3: number(row.placed_volume_m3, 0)
	};
}

export function quantitiesFrom(row: ReconstructionRow): SubstrateQuantity[] {
	if (!row.quantities_json) return [];
	const parsed: unknown = JSON.parse(row.quantities_json);
	return Array.isArray(parsed) ? (parsed as SubstrateQuantity[]) : [];
}

export function ratesFrom(records: readonly RateRecord[], currency: string): RateRow[] {
	return records.flatMap((record) => {
		const substrate = record.substrate;
		const unit = record.unit;
		if (!substrate || !unit) return [];
		const rate = record.rate?.value;
		if (typeof rate !== 'number' || !Number.isFinite(rate)) return [];
		return [
			{
				substrate: substrate as SubstrateId,
				unit: unit as RateRow['unit'],
				rate,
				currency: record.rate?.currency ?? currency
			}
		];
	});
}

/**
 * Price one estimate.
 *
 * Rates quoted in a currency other than the estimate's are dropped rather than
 * converted: this workspace holds no exchange rates, and a silent conversion is
 * worse than a visibly missing line.
 */
export function priceEstimate(input: {
	readonly estimate: EstimateInput;
	readonly reconstruction: ReconstructionRow;
	readonly rates: readonly RateRecord[];
	readonly fallbackCurrency: string;
}): PricedEstimate {
	const currency = input.estimate.currency?.trim() || input.fallbackCurrency;
	const allRates = ratesFrom(input.rates, currency);
	const usableRates = allRates.filter((rate) => rate.currency === currency);
	const levers = leversFrom(input.estimate);

	const result = buildEstimate({
		quantities: quantitiesFrom(input.reconstruction),
		metrics: metricsFrom(input.reconstruction),
		rates: usableRates,
		levers,
		currency
	});

	const wrongCurrency = allRates
		.filter((rate) => rate.currency !== currency)
		.map((rate) => rate.substrate);

	return {
		reconstruction_id: input.reconstruction.norbital_id,
		currency,
		subtotal: { value: result.subtotal, currency },
		contingency: { value: result.contingency, currency },
		total: { value: result.total, currency },
		lines_json: JSON.stringify(result.lines),
		missing_rates: [...new Set([...result.missingRates, ...wrongCurrency])],
		priced_at: new Date().toISOString()
	};
}
