/**
 * One stitch driver, shared by everything that can trigger a reconstruction.
 *
 * The reconstruction automations and the rebuild command all need the same four
 * capabilities, and both run after commit with the ordinary API, so both write
 * through `db.site_reconstructions.create` — which exists only because that
 * collection declares a `create` behaviour. Nothing here is repeated per caller:
 * a trigger supplies a project id, and `reconstructProject` does the rest.
 */

import { runStitchForProject } from '../../collections/reclamation_projects/lib/run-stitch.js';
import type { ReconstructionWrite } from '../../collections/reclamation_projects/lib/run-stitch.js';
import type {
	ExtraDocument,
	PreviousRun,
	StitchDriver
} from '../../collections/reclamation_projects/lib/run-stitch.js';
// Type-only, and therefore erased: this module keeps its structural `StitchApi` so the driver stays
// testable on its own, and names the generated API only where a caller hands over the real one.
import type { Api } from '../../../.norbital/generated/types.js';

/** The subset of the server API a stitch needs, in either hook or remote form. */
export type StitchApi = {
	readonly readFileAsset: (assetId: string) => Promise<{
		readonly id: string;
		readonly name: string;
		readonly mimeType: string | null;
		readonly size: number;
		readonly bytes: Uint8Array;
	}>;
	readonly db: {
		readonly query: {
			readonly site_reconstructions: {
				findMany(query: unknown): Promise<readonly Record<string, unknown>[]>;
			};
			readonly project_documents: {
				findMany(query: unknown): Promise<readonly Record<string, unknown>[]>;
			};
		};
	};
};

export function stitchDriver(
	api: StitchApi,
	// Typed rather than `Record<string, unknown>`: this payload goes straight into an elevated,
	// permission-bypassing write, so an erased type would put a column typo on that path with nothing
	// to catch it. `ReconstructionWrite` is the generated insert type for the collection.
	write: (payload: ReconstructionWrite) => Promise<unknown>
): StitchDriver {
	return {
		readFileAsset: (assetId) => api.readFileAsset(assetId),
		writeReconstruction: write,
		previousRuns: async (projectId) =>
			(await api.db.query.site_reconstructions.findMany({
				where: { project_id: { eq: projectId } },
				orderBy: { revision: 'desc' },
				columns: { revision: true, report_json: true, status: true },
				limit: 50
			})) as readonly PreviousRun[],
		extraDocuments: async (projectId) =>
			(await api.db.query.project_documents.findMany({
				where: { project_id: { eq: projectId }, category: { eq: 'reconstruction' } },
				columns: { norbital_id: true, document_file: true, document_role: true, title: true },
				orderBy: { norbital_created_at: 'asc' },
				limit: 50
			})) as readonly ExtraDocument[]
	};
}

/** Columns a project needs for a stitch. Declared once so no caller drifts. */
export const PROJECT_STITCH_COLUMNS = {
	norbital_id: true,
	floor_plan_document: true,
	bathymetry_document: true,
	cross_section_document: true,
	interpolation: true,
	integration_cell_m: true,
	render_cell_m: true,
	stitch_overrides: true
} as const;

/** What one reconstruction attempt did, including the two cases that never reach the engine. */
export type ReconstructionOutcome =
	'stitched' | 'skipped' | 'failed' | 'missing_project' | 'unrelated_document';

/**
 * Reconstruct one project from its committed state.
 *
 * Every trigger — a saved project, an attached reconstruction document, the rebuild command —
 * funnels through here, and none of them pass the row they were handed: the project is re-read by
 * id so the stitch always describes what is actually stored, not what one event happened to carry.
 *
 * Idempotent by construction. `runStitchForProject` fingerprints the documents and settings and
 * compares that against the fingerprint recorded on the newest ready run, so a redelivered event,
 * a double save, or two triggers firing for one edit all return `skipped` instead of appending an
 * identical revision. `force` is the deliberate exception, and only the rebuild command uses it.
 */
export async function reconstructProject(
	api: Api,
	projectId: string | null | undefined,
	options: { readonly force?: boolean } = {}
): Promise<ReconstructionOutcome> {
	if (typeof projectId !== 'string' || projectId === '') return 'missing_project';
	const project = await api.db.query.reclamation_projects.findFirst({
		where: { norbital_id: { eq: projectId } },
		columns: PROJECT_STITCH_COLUMNS
	});
	if (!project) return 'missing_project';
	return runStitchForProject(
		project,
		stitchDriver(api, (payload) =>
			api.db.site_reconstructions.create(
				payload as Parameters<typeof api.db.site_reconstructions.create>[0]
			)
		),
		options
	);
}

/**
 * Reconstruct after a `project_documents` row changes.
 *
 * Only the reconstruction category feeds the engine. Filing a tender letter or a correspondence
 * PDF against the project must not touch the model, and that test lives here rather than in three
 * near-identical automation files.
 */
export async function reconstructForDocument(
	api: Api,
	document: { readonly category?: string | null; readonly project_id?: string | null }
): Promise<ReconstructionOutcome> {
	if (document.category !== 'reconstruction') return 'unrelated_document';
	return reconstructProject(api, document.project_id);
}
