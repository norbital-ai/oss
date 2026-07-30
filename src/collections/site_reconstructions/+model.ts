import { defineModel, enums, numeric, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

/**
 * One stitch run: the 3D site solid derived from a project's three documents.
 *
 * Written only by `reclamation_projects/+hooks.ts`. A run is never overwritten —
 * each stitch appends a revision, so an estimate always points at the exact
 * geometry it was priced against.
 *
 * Headline numbers are ordinary columns so they can be listed, sorted, and
 * filtered. The three JSON payloads carry everything the viewer and the audit
 * trail need and are read as text.
 */
export default defineModel(
	{
		project_id: uuid().notNull(),
		revision: numeric().notNull(),
		status: enums(['ready', 'failed']).notNull(),
		stitched_at: timestamp(),
		engine_version: text(),
		/** Error message when `status` is `failed`. */
		failure_reason: text(),

		// Headline figures stay as columns so a list can sort and filter on them.
		platform_area_m2: numeric(),
		placed_volume_m3: numeric(),
		mean_fill_depth_m: numeric(),
		excavation_m3: numeric(),
		integration_cell_m: numeric(),

		assumption_count: numeric(),
		warning_count: numeric(),

		/** `StitchedModel` — the normalised model the viewer rebuilds surfaces from. */
		model_json: text(),
		/** `ReconstructionMetrics` — every measured figure, in one shape. */
		metrics_json: text(),
		/** `SubstrateQuantity[]` — quantities as integrated from the solid. */
		quantities_json: text(),
		/** `StitchReport` — assumptions, warnings, and document provenance. */
		report_json: text()
	},
	{
		description:
			'Derived 3D reconstructions of a reclamation site, with integrated volumes and the assumption ledger for each stitch run.',
		recordLabel: 'revision',
		icon: 'lucide:box',
		indexes: [{ columns: ['project_id'] }, { columns: ['project_id', 'revision'], unique: true }]
	}
);
