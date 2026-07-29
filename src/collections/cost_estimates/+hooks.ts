import type { Hooks } from './$types.js';
import {
	priceEstimate,
	type EstimateInput,
	type RateRecord,
	type ReconstructionRow
} from './lib/price-estimate.js';

/**
 * Recompute an estimate on every write.
 *
 * Pricing happens in `before` so the stored totals land in the same write as the
 * levers that produced them; there is no window in which an estimate shows a
 * total that does not match its own inputs.
 */

type CreateBefore = NonNullable<NonNullable<Hooks['create']>['before']>;
type HookApi = Parameters<CreateBefore>[0]['api'];

const RECONSTRUCTION_COLUMNS = {
	norbital_id: true,
	status: true,
	quantities_json: true,
	platform_area_m2: true,
	works_footprint_m2: true,
	armor_face_area_m2: true,
	shoreline_length_m: true,
	mean_fill_depth_m: true,
	max_fill_depth_m: true,
	integration_cell_m: true,
	structure_displacement_m3: true,
	excavation_m3: true,
	placed_volume_m3: true
} as const;

async function resolveReconstruction(
	estimate: EstimateInput,
	api: HookApi
): Promise<ReconstructionRow> {
	if (estimate.reconstruction_id) {
		const row = await api.db.query.site_reconstructions.findFirst({
			where: { norbital_id: { eq: estimate.reconstruction_id } },
			columns: RECONSTRUCTION_COLUMNS
		});
		if (!row) throw new Error('The referenced reconstruction does not exist.');
		if (row.status !== 'ready') {
			throw new Error('That reconstruction did not produce a solid, so it cannot be priced.');
		}
		return row as ReconstructionRow;
	}

	if (!estimate.project_id) throw new Error('An estimate needs a project.');
	const runs = await api.db.query.site_reconstructions.findMany({
		where: { project_id: { eq: estimate.project_id }, status: { eq: 'ready' } },
		orderBy: { revision: 'desc' },
		columns: RECONSTRUCTION_COLUMNS,
		limit: 1
	});
	const latest = runs[0];
	if (!latest) {
		throw new Error(
			'This project has no successful reconstruction yet. Upload the floor plan, bathymetry, and cross-section documents first.'
		);
	}
	return latest as ReconstructionRow;
}

async function price(estimate: EstimateInput, api: HookApi): Promise<Record<string, unknown>> {
	const reconstruction = await resolveReconstruction(estimate, api);
	const rates = (await api.db.query.cost_rates.findMany({
		columns: { substrate: true, unit: true, rate: true },
		limit: 100
	})) as readonly RateRecord[];

	const project = estimate.project_id
		? await api.db.query.reclamation_projects.findFirst({
				where: { norbital_id: { eq: estimate.project_id } },
				columns: { currency: true }
			})
		: null;

	return {
		...priceEstimate({
			estimate,
			reconstruction,
			rates,
			fallbackCurrency: project?.currency?.trim() || 'SGD'
		})
	};
}

export default {
	create: {
		before: async ({ input, api }) => ({ ...input, ...(await price(input, api)) })
	},
	update: {
		before: async ({ input, existing, api }) => {
			const merged = { ...existing, ...input } as EstimateInput;
			return { ...input, ...(await price(merged, api)) };
		}
	}
} satisfies Hooks;
