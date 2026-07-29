import type { Hooks } from './$types.js';
import {
	parseOverrides,
	runStitchForProject,
	type ExtraDocument,
	type PreviousRun,
	type ProjectDocumentFields,
	type StitchDriver
} from './lib/run-stitch.js';

/**
 * The 3D reconstruction runs here.
 *
 * `before` validates only what has to be right before the row lands: an
 * override blob has to be JSON, and the tuning cells have to be sane. The stitch
 * itself runs in `after`, because it reads file assets, walks a survey grid, and
 * writes a `site_reconstructions` revision — work that belongs after the project
 * row is durable, not inside the write that creates it.
 *
 * The project row is never mutated by these hooks, so a stitch cannot re-enter
 * them. Status is read from the newest reconstruction revision instead.
 */

type CreateAfter = NonNullable<NonNullable<Hooks['create']>['after']>;
type AfterApi = Parameters<CreateAfter>[0]['api'];
type ProjectRecord = Parameters<CreateAfter>[0]['record'];

function driverFor(api: AfterApi): StitchDriver {
	return {
		readFileAsset: (assetId) => api.readFileAsset(assetId),
		previousRuns: async (projectId) => {
			const runs = await api.db.query.site_reconstructions.findMany({
				where: { project_id: { eq: projectId } },
				orderBy: { revision: 'desc' },
				columns: { revision: true, report_json: true, status: true },
				limit: 50
			});
			return runs as readonly PreviousRun[];
		},
		writeReconstruction: (payload) => api.db.mutate('site_reconstructions', [payload]),
		extraDocuments: async (projectId) => {
			const rows = await api.db.query.project_documents.findMany({
				where: { project_id: { eq: projectId }, category: { eq: 'reconstruction' } },
				columns: { norbital_id: true, document_file: true, document_role: true, title: true },
				orderBy: { norbital_created_at: 'asc' },
				limit: 50
			});
			return rows as readonly ExtraDocument[];
		}
	};
}

function projectFields(record: ProjectRecord): ProjectDocumentFields {
	return {
		norbital_id: record.norbital_id,
		floor_plan_document: record.floor_plan_document,
		bathymetry_document: record.bathymetry_document,
		cross_section_document: record.cross_section_document,
		interpolation: record.interpolation,
		integration_cell_m: record.integration_cell_m,
		render_cell_m: record.render_cell_m,
		stitch_overrides: record.stitch_overrides
	};
}

function validateTuning(input: {
	integration_cell_m?: number | null;
	render_cell_m?: number | null;
	stitch_overrides?: string | null;
}): void {
	parseOverrides(input.stitch_overrides);
	for (const [label, value] of [
		['Integration cell', input.integration_cell_m],
		['Render cell', input.render_cell_m]
	] as const) {
		if (value == null) continue;
		if (!Number.isFinite(value) || value < 0.5 || value > 100) {
			throw new Error(`${label} size must be between 0.5 m and 100 m.`);
		}
	}
}

export default {
	create: {
		before: async ({ input }) => {
			validateTuning(input);
			return input;
		},
		after: async ({ record, api }) => {
			await runStitchForProject(projectFields(record), driverFor(api));
		}
	},
	update: {
		before: async ({ input }) => {
			validateTuning(input);
			return input;
		},
		after: async ({ record, api }) => {
			// `runStitchForProject` compares the current documents and settings
			// against the fingerprint stored on the newest run, so an unrelated edit
			// (a rename, a status change) does not re-integrate the site.
			await runStitchForProject(projectFields(record), driverFor(api));
		}
	}
} satisfies Hooks;
