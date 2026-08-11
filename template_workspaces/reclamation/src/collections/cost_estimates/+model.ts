import {
	custom,
	defineModel,
	enums,
	numeric,
	text,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

/**
 * A priced take-off against one reconstruction revision.
 *
 * The lever columns are the only numbers an estimator types. Quantities come
 * from the solid and rates come from the matrix; `+hooks.ts` recomputes the
 * lines and totals server-side on every write, so a stored total always matches
 * the geometry and the rates it claims to be built from.
 */
export default defineModel(
	{
		estimate_name: text({ search: true }).notNull(),
		project_id: uuid().notNull(),
		/** The exact reconstruction revision priced. Blank means the latest at write time. */
		reconstruction_id: uuid(),
		status: enums(['draft', 'issued', 'superseded']),
		currency: text(),

		/** Placement and washout loss added to sand fill (%). */
		sand_loss_pct: numeric(),
		/** Placement loss added to dredged and excavated fill (%). */
		dredged_fill_loss_pct: numeric(),
		/** Margin on perimeter-driven quantities for an uneven reclaim edge (%). */
		perimeter_margin_pct: numeric(),
		/** Share of the platform receiving vertical drains (0–1). */
		pvd_area_fraction: numeric(),
		/** Triangular PVD grid spacing (m). */
		pvd_spacing_m: numeric(),
		/** Contingency on the subtotal (%). */
		contingency_pct: numeric(),

		subtotal: custom('money'),
		contingency: custom('money'),
		total: custom('money'),
		/** `CostLine[]` — one entry per substrate, with quantity, rate, and basis. */
		lines_json: text(),
		priced_at: timestamp(),
		notes: text()
	},
	{
		description:
			'Cost estimates built from a stitched reconstruction, the unit cost matrix, and per-project commercial levers.',
		recordLabel: 'estimate_name',
		icon: 'lucide:calculator',
		indexes: [{ columns: ['project_id'] }]
	}
);
