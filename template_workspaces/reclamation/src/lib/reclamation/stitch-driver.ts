/**
 * One stitch driver, shared by everything that can trigger a reconstruction.
 *
 * The project hooks, the document hooks, and the rebuild command all need the
 * same four capabilities. They differ only in how the runtime lets them write:
 * an `after` hook is elevated and writes through `db.mutate`, while a remote
 * command handler gets the ordinary API and writes through
 * `db.site_reconstructions.create` — which exists only because that collection
 * declares a `create` behaviour. That single difference is the argument;
 * nothing else is repeated.
 */

import type {
	ExtraDocument,
	PreviousRun,
	StitchDriver
} from '../../collections/reclamation_projects/lib/run-stitch.js';

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
	write: (payload: Record<string, unknown>) => Promise<unknown>
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
