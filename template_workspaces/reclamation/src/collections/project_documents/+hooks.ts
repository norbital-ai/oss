import type { Hooks } from './$types.js';
import {
	runStitchForProject,
	type ExtraDocument,
	type PreviousRun,
	type StitchDriver
} from '../reclamation_projects/lib/run-stitch.js';

/**
 * Keep the reconstruction in step with the documents attached to a project.
 *
 * Attaching, re-roling, or removing a `reconstruction` document changes the
 * model, so the stitch re-runs. `runStitchForProject` fingerprints the whole
 * input set, so filing a tender document — which the engine never reads — leaves
 * the existing revision alone.
 */

type CreateAfter = NonNullable<NonNullable<Hooks['create']>['after']>;
type AfterApi = Parameters<CreateAfter>[0]['api'];
type DocumentRecord = Parameters<CreateAfter>[0]['record'];

const PROJECT_COLUMNS = {
	norbital_id: true,
	floor_plan_document: true,
	bathymetry_document: true,
	cross_section_document: true,
	interpolation: true,
	integration_cell_m: true,
	render_cell_m: true,
	stitch_overrides: true
} as const;

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

async function restitch(record: DocumentRecord, api: AfterApi): Promise<void> {
	if (record.category !== 'reconstruction') return;
	const project = await api.db.query.reclamation_projects.findFirst({
		where: { norbital_id: { eq: record.project_id } },
		columns: PROJECT_COLUMNS
	});
	if (!project) return;
	await runStitchForProject(project, driverFor(api));
}

export default {
	create: {
		before: async ({ input }) => {
			if (input.category === 'reconstruction' && input.document_role == null) {
				throw new Error(
					'A reconstruction document needs a role: additional sections, additional bathymetry, or supporting.'
				);
			}
			return input;
		},
		after: async ({ record, api }) => {
			await restitch(record, api);
		}
	},
	update: {
		after: async ({ record, api }) => {
			await restitch(record, api);
		}
	},
	delete: {
		after: async ({ record, api }) => {
			await restitch(record, api);
		}
	}
} satisfies Hooks;
