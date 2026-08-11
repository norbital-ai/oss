import { custom, dateRange, defineModel, enums, text } from '@norbital-ai/pod/authoring';

/**
 * The unit cost matrix.
 *
 * One row per priced substrate, shared by every project. Rates are commercial
 * data, not geometry: nothing in the reconstruction reads this collection, and
 * changing a rate never changes a volume.
 */
export default defineModel(
	{
		substrate: enums([
			'rock_armor',
			'geofabric',
			'dredged_rock',
			'sand_key',
			'sand_fill',
			'dredged_fill',
			'pvd'
		]).notNull(),
		label: text({ search: true }).notNull(),
		unit: enums(['m3', 'm2', 'm']).notNull(),
		rate: custom('money'),
		/** Where the rate came from: tender return, benchmark, or an assumption. */
		rate_basis: enums(['tender', 'benchmark', 'assumption']),
		source: text(),
		validity_range: dateRange(),
		notes: text()
	},
	{
		description:
			'Unit rates per reclamation substrate. Shared across projects and applied to stitched quantities to produce a cost estimate.',
		recordLabel: 'label',
		icon: 'lucide:table-2',
		indexes: [{ columns: ['substrate'], unique: true }]
	}
);
