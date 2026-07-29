import { defineCommandHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import {
	runStitchForProject,
	type PreviousRun,
	type ProjectDocumentFields
} from '../collections/reclamation_projects/lib/run-stitch.js';
import type { Api } from './$types.js';

/**
 * Re-run the reconstruction for one project on demand.
 *
 * The project hooks already stitch on every write, so this exists for the cases
 * a write does not cover: a project whose documents were loaded by a seed or an
 * import (which write straight to the database and never call a hook), and a
 * re-run against a newer engine version without touching the record.
 *
 * It is idempotent. `runStitchForProject` compares the current documents and
 * settings against the fingerprint stored on the newest run and returns
 * `skipped` when nothing has changed, so pressing the button twice does not
 * append an identical revision.
 */
export default defineCommandHandler({
	schema: z.object({
		project_id: z.string().uuid(),
		/** Append a revision even when the inputs are unchanged. */
		force: z.boolean().optional()
	}),
	handler: async ({ project_id, force }, api: Api) => {
		const project = await api.db.query.reclamation_projects.findFirst({
			where: { norbital_id: { eq: project_id } },
			columns: {
				norbital_id: true,
				floor_plan_document: true,
				bathymetry_document: true,
				cross_section_document: true,
				interpolation: true,
				integration_cell_m: true,
				render_cell_m: true,
				stitch_overrides: true
			}
		});
		if (!project) throw new Error('That project does not exist.');

		const outcome = await runStitchForProject(
			project as ProjectDocumentFields,
			{
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
				writeReconstruction: (payload) =>
					api.db.site_reconstructions.create(
						payload as Parameters<typeof api.db.site_reconstructions.create>[0]
					)
			},
			{ force: force === true }
		);

		return { outcome };
	}
});
