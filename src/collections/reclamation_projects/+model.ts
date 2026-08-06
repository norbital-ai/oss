import { defineModel, enums, file, numeric, text } from '@norbital-ai/pod/authoring';

/**
 * A reclamation project and the three documents the 3D reconstruction needs.
 *
 * The document fields are the *inputs* to the stitch hook. Everything derived
 * from them — the model, the volumes, the assumption ledger — lands on
 * `site_reconstructions`, so this record stays small enough to list and filter.
 */
export default defineModel(
	{
		project_name: text().notNull(),
		project_code: text(),
		client: text(),
		consultant: text(),
		status: enums(['planning', 'design', 'tender', 'construction', 'complete', 'on_hold']),
		location: text(),
		/** Vertical datum every level in the documents is quoted against. */
		datum: text(),
		currency: text(),

		/** Site key plan: boundaries, existing structures, and the reclamation extent. */
		floor_plan_document: file({
			mimeTypes: ['image/vnd.dxf', 'application/dxf', 'application/json', 'text/plain']
		}),
		/** Bathymetric and topographic survey of the existing bed. */
		bathymetry_document: file({
			mimeTypes: ['text/plain', 'text/csv', 'image/vnd.dxf', 'application/dxf', 'application/json']
		}),
		/**
		 * Section sheet profiles: levels, slopes, crest and armour dimensions.
		 *
		 * DXF and JSON only. Native DWG is deliberately absent: the reconstruction
		 * cannot decode it inside the tenant runtime's memory envelope, and offering
		 * a file type that is certain to fail at Build time is worse than not
		 * offering it. PDF is likewise absent — `normalizeDrawing` recognises a
		 * vector sheet but refuses to treat plotted sheet coordinates as
		 * engineering geometry.
		 */
		cross_section_document: file({
			mimeTypes: ['image/vnd.dxf', 'application/dxf', 'application/json']
		}),

		/** How geometry is carried between two section cuts. */
		interpolation: enums(['morph', 'prismatic']),
		/** Plan cell size used to integrate volumes (m). */
		integration_cell_m: numeric(),
		/** Plan cell size used to tessellate the viewer surfaces (m). */
		render_cell_m: numeric(),
		/**
		 * Engineer-supplied values that win over anything read from a document:
		 * `layerMapping`, `levelsM`, `slopes`, `dimensionsM`, `seawardFaceKind`,
		 * `shorelineLengthM`, `datum`. Stored as JSON text.
		 */
		stitch_overrides: text(),

		notes: text()
	},
	{
		description:
			'Land reclamation projects and the floor plan, bathymetry, and cross-section documents that the 3D reconstruction is stitched from.',
		recordLabel: 'project_name',
		icon: 'lucide:waves',
		indexes: [{ columns: ['project_code'], unique: true }]
	}
);
