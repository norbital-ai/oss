import { PROJECT_STITCH_COLUMNS, stitchDriver } from '../../lib/reclamation/stitch-driver.js';
import { runStitchForProject } from '../reclamation_projects/lib/run-stitch.js';
import type { Hooks } from './$types.js';

/**
 * Keep the reconstruction in step with the documents attached to a project.
 *
 * Attaching, re-roling, or removing a `reconstruction` document changes the
 * model, so the stitch re-runs. The driver fingerprints the whole input set, so
 * filing a tender document — which the engine never reads — leaves the existing
 * revision alone.
 */

type CreateAfter = NonNullable<NonNullable<Hooks['create']>['after']>;
type AfterContext = Parameters<CreateAfter>[0];

async function restitch({ record, api }: AfterContext): Promise<void> {
	if (record.category !== 'reconstruction') return;
	const project = await api.db.query.reclamation_projects.findFirst({
		where: { norbital_id: { eq: record.project_id } },
		columns: PROJECT_STITCH_COLUMNS
	});
	if (!project) return;
	await runStitchForProject(
		project,
		stitchDriver(api, (payload) => api.db.mutate('site_reconstructions', [payload]))
	);
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
		after: restitch
	},
	update: { after: restitch },
	delete: { after: restitch }
} satisfies Hooks;
