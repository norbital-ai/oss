/**
 * Layer vocabulary for section profiles.
 *
 * A profile point's `layer` is the only thing that tells the engine whether the
 * point is on the finished surface, on an internal material interface, or on a
 * cut below grade. Both the document reader and the surface sampler use these
 * predicates, so the vocabulary lives on its own.
 *
 * The keyword lists are defaults, not a fixed schema. A drawing set that names
 * its layers differently is handled by `profileLayers` in the project overrides,
 * and every run reports how each layer it actually saw was classified.
 */

import type { ProfilePoint } from './types.js';

/** Layers that describe an internal interface or a cut, not the finished top. */
export const NON_SURFACE_PROFILE_LAYERS = [
	'seabed',
	'ground',
	'existing_ground',
	'sand_key',
	'key',
	'dredge',
	'dredged',
	'bund_landward_toe',
	'inner_fill',
	'inner_face',
	'core',
	'filter',
	'bedding',
	'soil_improvement_limit',
	'geofabric',
	'geotextile'
] as const;

/** Layers that mean the perimeter is an earth-retaining wall, not a rock slope. */
export const CAISSON_PROFILE_LAYERS = ['caisson', 'quay', 'wall', 'sheet_pile'] as const;

/** Layers that mark a profile as reaching the seaward perimeter. */
export const TOE_PROFILE_LAYERS = ['toe', 'quay_crest', 'seaward_toe'] as const;

/**
 * Which priced substrate a below-grade section layer represents.
 *
 * A layer named here is not just excluded from the finished surface — it is read
 * as a material band with its own invert level, dug and filled against the real
 * bed. Matched on substring, longest key first, and overridable per project.
 */
export const SUBGRADE_SUBSTRATE: Readonly<Record<string, string>> = {
	sand_key: 'sand_key',
	key: 'sand_key',
	dredged_rock: 'dredged_rock',
	foundation_rock: 'dredged_rock',
	bedding: 'dredged_rock',
	geofabric: 'geofabric',
	geotextile: 'geofabric'
};

/** Resolve a layer name to a priced substrate, if it is a sub-grade band. */
export function subgradeSubstrate(
	layer: string,
	overrides?: Readonly<Record<string, string>>
): string | undefined {
	const table = { ...SUBGRADE_SUBSTRATE, ...(overrides ?? {}) };
	const keys = Object.keys(table).sort((a, b) => b.length - a.length);
	for (const key of keys) {
		if (layer.includes(key)) return table[key];
	}
	return undefined;
}

export type LayerOverrides = {
	/** Extra layers to treat as finished surface, whatever the keyword lists say. */
	readonly surface?: readonly string[];
	/** Extra layers to treat as internal or below-grade. */
	readonly internal?: readonly string[];
	/** Extra layers that mark a profile as a perimeter section. */
	readonly toe?: readonly string[];
	/** Extra layers that carry the finished platform level. */
	readonly platform?: readonly string[];
	/** Map this drawing set's below-grade layer names onto priced substrates. */
	readonly subgrade?: Readonly<Record<string, string>>;
};

function matches(layer: string, keywords: readonly string[]): boolean {
	return keywords.some((keyword) => layer.includes(keyword));
}

export function isSurfaceLayer(layer: string, overrides?: LayerOverrides): boolean {
	if (overrides?.surface?.some((entry) => layer === entry.toLowerCase())) return true;
	if (overrides?.internal?.some((entry) => layer === entry.toLowerCase())) return false;
	return !matches(layer, NON_SURFACE_PROFILE_LAYERS);
}

/**
 * A profile describes the perimeter when it reaches the seaward toe. A section
 * drawn across an internal bund describes that structure instead, and must not
 * be wrapped around the perimeter.
 */
export function isPerimeterProfile(
	points: readonly ProfilePoint[],
	overrides?: LayerOverrides
): boolean {
	const toeLayers = [
		...TOE_PROFILE_LAYERS,
		...(overrides?.toe ?? []).map((entry) => entry.toLowerCase())
	];
	return points.some((point) => toeLayers.includes(point.layer) || point.layer.includes('toe_'));
}

export type ProfileClassification = {
	readonly perimeterIds: readonly string[];
	readonly structureIds: readonly string[];
	/** False when no profile named a toe and every section had to be taken as perimeter. */
	readonly explicit: boolean;
	/** Every layer seen, and how it was read. For the run report. */
	readonly layers: readonly {
		readonly layer: string;
		readonly role: 'surface' | 'internal';
	}[];
};

/**
 * Split the supplied sections into perimeter and structure sections.
 *
 * When no section names a toe there is no basis to tell the two apart, so every
 * section is treated as a perimeter section and the caller records that as an
 * assumption. That keeps an unlabelled drawing usable instead of rejecting it.
 */
export function classifyProfiles(
	profiles: Readonly<Record<string, readonly ProfilePoint[]>>,
	overrides?: LayerOverrides
): ProfileClassification {
	const ids = Object.keys(profiles);
	const perimeterIds = ids.filter((id) => isPerimeterProfile(profiles[id], overrides));
	const seen = new Map<string, 'surface' | 'internal'>();
	for (const id of ids) {
		for (const point of profiles[id]) {
			if (seen.has(point.layer)) continue;
			seen.set(point.layer, isSurfaceLayer(point.layer, overrides) ? 'surface' : 'internal');
		}
	}
	const layers = [...seen.entries()]
		.map(([layer, role]) => ({ layer, role }))
		.sort((a, b) => a.layer.localeCompare(b.layer));

	if (perimeterIds.length === 0) {
		return { perimeterIds: ids, structureIds: [], explicit: false, layers };
	}
	return {
		perimeterIds,
		structureIds: ids.filter((id) => !perimeterIds.includes(id)),
		explicit: true,
		layers
	};
}
