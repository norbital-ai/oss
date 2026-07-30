import { defineCommandHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import { PROJECT_STITCH_COLUMNS, stitchDriver } from '../lib/reclamation/stitch-driver.js';
import { runStitchForProject } from '../collections/reclamation_projects/lib/run-stitch.js';
import type { Api } from './$types.js';

/**
 * Re-run the reconstruction for one project on demand.
 *
 * The project hooks already stitch on every write, so this exists for the cases
 * a write does not cover: documents loaded by a seed or an import, which go
 * straight to the database and never call a hook, and a re-run against a newer
 * engine version without touching the record.
 *
 * Idempotent: unchanged inputs return `skipped`, so pressing twice does not
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
			columns: PROJECT_STITCH_COLUMNS
		});
		if (!project) throw new Error('That project does not exist.');

		const outcome = await runStitchForProject(
			project,
			stitchDriver(api, (payload) =>
				api.db.site_reconstructions.create(
					payload as Parameters<typeof api.db.site_reconstructions.create>[0]
				)
			),
			{ force: force === true }
		);
		return { outcome };
	}
});
