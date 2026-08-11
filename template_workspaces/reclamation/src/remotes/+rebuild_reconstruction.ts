import { defineCommandHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import { reconstructProject } from '../lib/reclamation/stitch-driver.js';

/**
 * Re-run the reconstruction for one project on demand.
 *
 * The reconstruction automations already stitch on every project and document
 * write, so this exists for the cases a write does not cover: documents loaded
 * by a seed or an import, which go straight to the database and trigger nothing,
 * and a re-run against a newer engine version without touching the record.
 *
 * Idempotent: unchanged inputs return `skipped`, so pressing twice does not
 * append an identical revision. `force` is the explicit opt-out.
 */
export default defineCommandHandler({
	description:
		'Re-runs the stitch for one project on demand and returns its newest site reconstruction, for documents loaded by a seed or an import that never fired a write.',
	schema: z.object({
		project_id: z.string().uuid(),
		/** Append a revision even when the inputs are unchanged. */
		force: z.boolean().optional()
	}),
	handler: async ({ project_id, force }, api) => {
		const outcome = await reconstructProject(api, project_id, { force: force === true });
		if (outcome === 'missing_project') throw new Error('That project does not exist.');
		// The command commits outside the client's local mutation path. Return the row that this
		// invocation just made authoritative so the mounted model can render it immediately while
		// the ordinary sync stream catches up in the background.
		const reconstruction = await api.db.query.site_reconstructions.findFirst({
			where: { project_id: { eq: project_id } },
			orderBy: { revision: 'desc' }
		});
		return { outcome, reconstruction };
	}
});
