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

/**
 * Canonical role for a drawing office's own layer name.
 *
 * Nobody names a layer `crest_seaward`. Real tender sets use discipline codes —
 * `C-REVT-TOE`, `C-RECL-PLAT`, `SEC1-SANDKEY` — and the engineering role is one
 * token inside them. Matching whole tokens rather than substrings keeps that
 * cheap and safe: a layer has to actually contain the word `toe`, not merely
 * have those three letters somewhere in it.
 *
 * A layer with no recognised token keeps its own name, so nothing is silently
 * renamed, and `profileLayers` in the project overrides still has the last word.
 */
const ROLE_TOKENS: readonly (readonly [string, readonly string[]])[] = [
	['crest_seaward', ['crest seaward', 'crestseaward', 'crst sea', 'seaward crest']],
	['armor_crest', ['armor crest', 'armour crest', 'armr crst', 'crest armor', 'crest armour']],
	['crest_landward', ['crest landward', 'crestlandward', 'crst land', 'landward crest']],
	['bund_landward_toe', ['bund landward toe', 'inner toe', 'landward toe', 'rear toe']],
	['sand_key', ['sand key', 'sandkey', 'sndkey', 'snd key']],
	[
		'dredged_rock',
		['dredged rock', 'dredgedrock', 'foundation rock', 'rock foundation', 'bedding']
	],
	['geofabric', ['geofabric', 'geotextile', 'geotex']],
	['seabed', ['seabed', 'sea bed', 'existing bed', 'bed level', 'dredged level']],
	['existing_ground', ['existing ground', 'existing land', 'ground level', 'existing profile']],
	['interim', ['interim']],
	['sea', ['sea level', 'water level', 'swl', 'mwl']],
	['platform', ['platform', 'plat', 'pltf', 'deck', 'recl']],
	['crest', ['crest', 'crst']],
	['toe', ['toe']],
	['hwm', ['hwm', 'hwl', 'mhws']]
];

export function canonicalRole(layer: string): string {
	const tokens = layer
		.trim()
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (tokens.length === 0) return layer.trim().toLowerCase();
	const joined = tokens.join(' ');
	for (const [role, aliases] of ROLE_TOKENS) {
		for (const alias of aliases) {
			const parts = alias.split(' ');
			if (parts.length === 1) {
				if (tokens.includes(parts[0])) return role;
				continue;
			}
			if (joined.includes(alias)) return role;
		}
	}
	return layer.trim().toLowerCase();
}

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

/**
 * Reference lines: levels a section draws to be read, not surfaces to be built.
 *
 * A water line and a material-change line are horizontal rules that run right
 * across the sheet, so taking them as finished ground would drag the design
 * surface down to them and extend the works out to wherever the draughtsman
 * stopped the line. They are matched exactly rather than by substring, because
 * `sea` is a substring of `crest_seaward`.
 */
export const REFERENCE_PROFILE_LAYERS = [
	'sea',
	'sea_level',
	'swl',
	'mwl',
	'water',
	'water_level',
	'interim',
	'interim_level'
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
	if ((REFERENCE_PROFILE_LAYERS as readonly string[]).includes(layer)) return false;
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
