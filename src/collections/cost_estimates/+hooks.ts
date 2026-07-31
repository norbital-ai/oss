import {
	buildEstimate,
	DEFAULT_LEVERS,
	unpricedMessage,
	type CostLevers,
	type RateRow
} from '../../lib/reclamation/cost.js';
import type { ReconstructionMetrics, SubstrateQuantity } from '../../lib/reclamation/types.js';
import type { Hooks } from './$types.js';

/**
 * Recompute an estimate on every write.
 *
 * Pricing happens in `before` so the stored totals land in the same write as the
 * levers that produced them; there is no window in which an estimate shows a
 * total that does not match its own inputs.
 *
 * A measured substrate with no rate is refused rather than priced at zero. An
 * estimate that silently omits a material reads as complete when it is not.
 */

type CreateBefore = NonNullable<NonNullable<Hooks['create']>['before']>;
type HookApi = Parameters<CreateBefore>[0]['api'];

const RECONSTRUCTION_COLUMNS = {
	norbital_id: true,
	status: true,
	metrics_json: true,
	quantities_json: true
} as const;

type EstimateInput = {
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

const number = (value: number | null | undefined, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function leversFrom(input: EstimateInput): CostLevers {
	return {
		sandLossPct: number(input.sand_loss_pct, DEFAULT_LEVERS.sandLossPct),
		dredgedFillLossPct: number(input.dredged_fill_loss_pct, DEFAULT_LEVERS.dredgedFillLossPct),
		perimeterMarginPct: number(input.perimeter_margin_pct, DEFAULT_LEVERS.perimeterMarginPct),
		pvdAreaFraction: number(input.pvd_area_fraction, DEFAULT_LEVERS.pvdAreaFraction),
		pvdSpacingM: number(input.pvd_spacing_m, DEFAULT_LEVERS.pvdSpacingM),
		contingencyPct: number(input.contingency_pct, DEFAULT_LEVERS.contingencyPct)
	};
}

function parse<T>(json: unknown, fallback: T): T {
	if (typeof json !== 'string' || json === '') return fallback;
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}

async function price(estimate: EstimateInput, api: HookApi): Promise<Record<string, unknown>> {
	const reconstruction = estimate.reconstruction_id
		? await api.db.query.site_reconstructions.findFirst({
				where: { norbital_id: { eq: estimate.reconstruction_id } },
				columns: RECONSTRUCTION_COLUMNS
			})
		: (
				await api.db.query.site_reconstructions.findMany({
					where: { project_id: { eq: estimate.project_id ?? '' }, status: { eq: 'ready' } },
					orderBy: { revision: 'desc' },
					columns: RECONSTRUCTION_COLUMNS,
					limit: 1
				})
			)[0];

	if (!reconstruction) {
		throw new Error(
			'This project has no successful reconstruction to price. Attach the floor plan, bathymetry, and cross-section documents first.'
		);
	}
	if (reconstruction.status !== 'ready') {
		throw new Error('That reconstruction did not produce a solid, so it cannot be priced.');
	}

	const project = estimate.project_id
		? await api.db.query.reclamation_projects.findFirst({
				where: { norbital_id: { eq: estimate.project_id } },
				columns: { currency: true }
			})
		: null;
	const currency = estimate.currency?.trim() || project?.currency?.trim() || 'SGD';

	const rates = (
		await api.db.query.cost_rates.findMany({
			columns: { substrate: true, unit: true, rate: true },
			limit: 100
		})
	).flatMap((row): RateRow[] => {
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
	});

	const result = buildEstimate({
		quantities: parse<SubstrateQuantity[]>(reconstruction.quantities_json, []),
		metrics: parse<ReconstructionMetrics>(reconstruction.metrics_json, {} as ReconstructionMetrics),
		rates,
		levers: leversFrom(estimate),
		currency
	});

	const incomplete = unpricedMessage(result);
	if (incomplete) throw new Error(incomplete);

	return {
		reconstruction_id: reconstruction.norbital_id,
		currency,
		subtotal: { value: result.subtotal, currency },
		contingency: { value: result.contingency, currency },
		total: { value: result.total, currency },
		lines_json: JSON.stringify(result.lines),
		priced_at: new Date().toISOString()
	};
}

export default {
	create: {
		before: async ({ input, api }) => ({ ...input, ...(await price(input, api)) })
	},
	update: {
		before: async ({ input, existing, api }) => ({
			...input,
			...(await price({ ...existing, ...input } as EstimateInput, api))
		})
	}
} satisfies Hooks;
