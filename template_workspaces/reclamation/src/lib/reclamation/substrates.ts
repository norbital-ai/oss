/**
 * The substrate register: every material the workspace knows how to price, and
 * every material it deliberately cannot.
 *
 * This is the single source of truth. The integrator reads it to know what to
 * measure, the cost matrix reads it to know what needs a rate, and the estimate
 * fails rather than under-pricing when a measured substrate has no rate. Adding
 * a material is one entry here.
 */

import type { QuantityUnit, SubstrateId } from './types.js';

export type SubstrateSource =
	/** Measured off the stitched solid. */
	| 'integrated'
	/** A prism from section dimensions, used when the drawings dimension it but do not draw it. */
	| 'analytic'
	/** Derived from commercial levers rather than geometry. */
	| 'lever';

export type SubstrateDefinition = {
	readonly id: SubstrateId;
	readonly label: string;
	readonly unit: QuantityUnit;
	readonly source: SubstrateSource;
	/** Which lever family adjusts the measured quantity. */
	readonly driver: 'perimeter' | 'platform' | 'improvement';
	readonly note: string;
};

/** Priced substrates. A quantity greater than zero here requires a rate. */
export const SUBSTRATES: readonly SubstrateDefinition[] = [
	{
		id: 'rock_armor',
		label: 'Rock armour',
		unit: 'm3',
		source: 'integrated',
		driver: 'perimeter',
		note: 'Blanket on the seaward face: thickness × true sloped area.'
	},
	{
		id: 'geofabric',
		label: 'Geofabric',
		unit: 'm2',
		source: 'integrated',
		driver: 'perimeter',
		note: 'One layer under the armour, 1:1 with the sloped face area.'
	},
	{
		id: 'dredged_rock',
		label: 'Dredged rock foundation',
		unit: 'm3',
		source: 'integrated',
		driver: 'perimeter',
		note: 'Foundation rock, dug to the invert drawn on the section.'
	},
	{
		id: 'sand_key',
		label: 'Sand key',
		unit: 'm3',
		source: 'integrated',
		driver: 'perimeter',
		note: 'Trench under the bund, dug to the invert drawn on the section.'
	},
	{
		id: 'sand_fill',
		label: 'Sand fill',
		unit: 'm3',
		source: 'integrated',
		driver: 'platform',
		note: 'Bund sand plus platform fill above the material change level.'
	},
	{
		id: 'dredged_fill',
		label: 'Dredged and excavated fill',
		unit: 'm3',
		source: 'integrated',
		driver: 'platform',
		note: 'Platform fill below the material change level.'
	},
	{
		id: 'pvd',
		label: 'PVD soil improvement',
		unit: 'm',
		source: 'lever',
		driver: 'improvement',
		note: 'Drain length from the treated area, grid spacing, and mean fill depth.'
	}
];

const BY_ID = new Map(SUBSTRATES.map((entry) => [entry.id, entry]));

export function substrateDefinition(id: SubstrateId): SubstrateDefinition {
	const found = BY_ID.get(id);
	if (!found) throw new Error(`Unknown substrate "${id}".`);
	return found;
}

/**
 * Work this workspace deliberately does not quantify.
 *
 * Each entry is something a reclamation estimate needs but that cannot be
 * derived from a plan, a survey, and a section — the documents simply do not
 * contain it. Listing them is the point: an estimate that silently omitted them
 * would read as complete when it is not.
 */
export type ManualTakeOff = {
	readonly id: string;
	readonly label: string;
	readonly unit: string;
	readonly why: string;
};

export const MANUAL_TAKE_OFF: readonly ManualTakeOff[] = [
	{
		id: 'caisson_concrete',
		label: 'Caisson or quay wall concrete',
		unit: 'm³ / unit',
		why: 'A vertical face is modelled as retained fill. Concrete volume, reinforcement, casting yard, and float-out are structural work the section does not dimension.'
	},
	{
		id: 'caisson_founding',
		label: 'Caisson founding trench and bedding',
		unit: 'm³',
		why: 'The trench a caisson is founded in is below the drawn toe and is not part of the fill solid.'
	},
	{
		id: 'dredging_disposal',
		label: 'Dredging and disposal',
		unit: 'm³',
		why: 'Excavation is measured and reported, but disposal route, haul distance, and licensing drive the rate — none of which is in the documents.'
	},
	{
		id: 'temporary_works',
		label: 'Temporary works',
		unit: 'sum',
		why: 'Bunds, silt curtains, working platforms, and discharge pontoons are means and methods, not permanent geometry.'
	},
	{
		id: 'surcharge',
		label: 'Surcharge and settlement allowance',
		unit: 'm³',
		why: 'Extra fill placed to pre-load the platform depends on a settlement analysis, not on the finished level.'
	},
	{
		id: 'services',
		label: 'Services, drainage, and pavements',
		unit: 'sum',
		why: 'Everything above the finished platform level is outside the reclamation solid.'
	},
	{
		id: 'monitoring',
		label: 'Instrumentation and monitoring',
		unit: 'sum',
		why: 'Settlement plates, piezometers, and survey control are a programme cost.'
	}
];
