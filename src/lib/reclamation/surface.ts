/**
 * Surface samplers: the single source of truth for "how high is the finished
 * design at this plan position".
 *
 * Both the server volume integrator and the browser viewer call these functions,
 * so the number that is priced and the surface that is drawn cannot drift apart.
 *
 * The works are described by a closed outline and the subset of its edges that
 * face water. Station is the inward distance from the nearest seaward edge, so a
 * straight coastal strip, a curved shoreline, and a comb of finger piers with
 * berth basins between them are all the same problem: every cell inside the
 * outline gets the perimeter section, applied normal to whichever quay or
 * revetment edge is nearest.
 */

import { distanceToPolyline, lerp, pointInPolygon, sampleSeabed } from './math.js';
import { isSurfaceLayer, subgradeSubstrate, type LayerOverrides } from './profile-layers.js';
import type {
	InterpolationMode,
	PlanGeometry,
	ProfileClassificationSnapshot,
	PlanStructure,
	Point2,
	ProfilePoint,
	SeabedGrid,
	SectionParameters,
	SlopeRatio,
	StitchedModel
} from './types.js';

export type ZoneId = 'armor' | 'crest' | 'platform';

/**
 * A below-grade material band read off the section.
 *
 * The section draws it as a polyline at its invert level, over a station range
 * that may be negative — a sand key trench sits seaward of the toe. Everything
 * is on the project datum, so the band is dug against the surveyed bed by
 * comparing two elevations on the same reference, never by assuming a depth.
 */
export type SubGradeBand = {
	readonly layer: string;
	readonly substrate: string;
	readonly stations: readonly number[];
	readonly invert: readonly number[];
	readonly minStation: number;
	readonly maxStation: number;
};

/** A section profile reduced to its finished top surface. */
export type TopSurface = {
	readonly id: string;
	readonly stations: readonly number[];
	readonly z: readonly number[];
	readonly minStation: number;
	readonly maxStation: number;
	/** Landward end of the armour blanket. */
	readonly armorEndStation: number;
	/** Landward end of the perimeter bund crest. */
	readonly crestEndStation: number;
	/** Below-grade bands: trenches and foundation layers, with their inverts. */
	readonly subGrade: readonly SubGradeBand[];
	/** How far seaward of the toe any band reaches. Zero when none do. */
	readonly seawardReachM: number;
};

function pushMonotone(stations: number[], z: number[], station: number, value: number): void {
	const last = stations.length - 1;
	if (last >= 0 && Math.abs(stations[last] - station) < 1e-9) {
		// A vertical face gives two elevations at one station; the top wins.
		z[last] = Math.max(z[last], value);
		return;
	}
	stations.push(station);
	z.push(value);
}

/** Reduce a section profile to the finished top surface and its zone limits. */
export function topSurfaceFromProfile(
	id: string,
	points: readonly ProfilePoint[],
	layerOverrides?: LayerOverrides
): TopSurface {
	const surfacePoints = points
		.filter((point) => isSurfaceLayer(point.layer, layerOverrides))
		.slice()
		.sort((a, b) => a.stationM - b.stationM);
	const stations: number[] = [];
	const z: number[] = [];
	for (const point of surfacePoints) pushMonotone(stations, z, point.stationM, point.zCdM);
	if (stations.length < 2) {
		throw new Error(`Section "${id}" has fewer than two finished-surface points.`);
	}

	const stationOf = (...layers: readonly string[]): number | undefined => {
		for (const layer of layers) {
			const found = surfacePoints.find((point) => point.layer === layer);
			if (found) return found.stationM;
		}
		return undefined;
	};
	// Without crest labels, the armour face is taken to run from the toe up to
	// where the section first reaches its highest point — the only reading a
	// polyline supports on its own.
	const highest = Math.max(...z);
	const firstStationAtCrest = stations[z.findIndex((value) => value >= highest - 1e-9)];
	const crestSeaward = stationOf('crest_seaward', 'quay_crest', 'crest') ?? firstStationAtCrest;
	const armorEnd = stationOf('armor_crest', 'armour_crest') ?? crestSeaward;
	const crestEnd = stationOf('crest_landward', 'caisson_landward') ?? armorEnd;

	// Below-grade bands: every non-surface layer that maps to a priced substrate,
	// kept as its own polyline so its invert can be compared against the bed.
	const bandsByLayer = new Map<string, { substrate: string; points: ProfilePoint[] }>();
	for (const point of points) {
		if (isSurfaceLayer(point.layer, layerOverrides)) continue;
		const substrate = subgradeSubstrate(point.layer, layerOverrides?.subgrade);
		if (!substrate) continue;
		const entry = bandsByLayer.get(point.layer) ?? { substrate, points: [] };
		entry.points.push(point);
		bandsByLayer.set(point.layer, entry);
	}
	const subGrade: SubGradeBand[] = [];
	for (const [layer, entry] of bandsByLayer) {
		const sorted = entry.points.slice().sort((a, b) => a.stationM - b.stationM);
		if (sorted.length < 2) continue;
		subGrade.push({
			layer,
			substrate: entry.substrate,
			stations: sorted.map((point) => point.stationM),
			invert: sorted.map((point) => point.zCdM),
			minStation: sorted[0].stationM,
			maxStation: sorted[sorted.length - 1].stationM
		});
	}
	const seawardReach = subGrade.reduce(
		(reach, band) => Math.max(reach, Math.max(0, stations[0] - band.minStation)),
		0
	);

	return {
		id,
		stations,
		z,
		minStation: stations[0],
		maxStation: stations[stations.length - 1],
		armorEndStation: armorEnd,
		crestEndStation: Math.max(crestEnd, armorEnd),
		subGrade,
		seawardReachM: seawardReach
	};
}

/** Invert level of a band at a station, or `undefined` outside its extent. */
export function sampleBandInvert(band: SubGradeBand, station: number): number | undefined {
	if (station < band.minStation - 1e-9 || station > band.maxStation + 1e-9) return undefined;
	const { stations, invert } = band;
	let low = 0;
	let high = stations.length - 1;
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (stations[middle] <= station) low = middle;
		else high = middle;
	}
	const span = stations[high] - stations[low];
	if (span <= 1e-9) return Math.min(invert[low], invert[high]);
	return lerp(invert[low], invert[high], (station - stations[low]) / span);
}

/**
 * Elevation of a top surface at a station.
 *
 * Seaward of the first station the works do not exist (`undefined`). Landward of
 * the last station the surface continues level — the section sheet stops at its
 * drawing edge, the plan says how far the platform actually runs.
 */
export function sampleTopSurface(surface: TopSurface, station: number): number | undefined {
	if (station < surface.minStation - 1e-9) return undefined;
	if (station >= surface.maxStation) return surface.z[surface.z.length - 1];
	const { stations, z } = surface;
	let low = 0;
	let high = stations.length - 1;
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (stations[middle] <= station) low = middle;
		else high = middle;
	}
	const span = stations[high] - stations[low];
	if (span <= 1e-9) return Math.max(z[low], z[high]);
	return lerp(z[low], z[high], (station - stations[low]) / span);
}

/* ------------------------------------------------------------ perimeter index */

type EdgeSegment = {
	readonly ax: number;
	readonly ay: number;
	readonly dx: number;
	readonly dy: number;
	readonly lengthSquared: number;
	readonly length: number;
	/** Distance along the concatenated seaward edges at this segment's start. */
	readonly arc0: number;
};

export type PerimeterIndex = {
	readonly segments: readonly EdgeSegment[];
	readonly totalLengthM: number;
};

/** Flatten the seaward edges into one measurable chain. */
export function buildPerimeterIndex(edges: readonly (readonly Point2[])[]): PerimeterIndex {
	const segments: EdgeSegment[] = [];
	let arc = 0;
	for (const edge of edges) {
		for (let index = 0; index < edge.length - 1; index++) {
			const [ax, ay] = edge[index];
			const [bx, by] = edge[index + 1];
			const dx = bx - ax;
			const dy = by - ay;
			const lengthSquared = dx * dx + dy * dy;
			if (lengthSquared <= 1e-12) continue;
			const length = Math.sqrt(lengthSquared);
			segments.push({ ax, ay, dx, dy, lengthSquared, length, arc0: arc });
			arc += length;
		}
	}
	if (segments.length === 0) {
		throw new Error('The floor plan defines no seaward perimeter edge for the works.');
	}
	return { segments, totalLengthM: arc };
}

export type PerimeterHit = {
	/** Shortest distance to a seaward edge — the profile station. */
	readonly stationM: number;
	/** Position along the perimeter, used to blend between section cuts. */
	readonly arcM: number;
};

/** Nearest seaward edge to a plan position. */
export function nearestPerimeter(index: PerimeterIndex, x: number, y: number): PerimeterHit {
	let bestDistanceSquared = Number.POSITIVE_INFINITY;
	let bestArc = 0;
	for (const segment of index.segments) {
		const t = Math.max(
			0,
			Math.min(
				1,
				((x - segment.ax) * segment.dx + (y - segment.ay) * segment.dy) / segment.lengthSquared
			)
		);
		const px = segment.ax + t * segment.dx;
		const py = segment.ay + t * segment.dy;
		const distanceSquared = (x - px) * (x - px) + (y - py) * (y - py);
		if (distanceSquared < bestDistanceSquared) {
			bestDistanceSquared = distanceSquared;
			bestArc = segment.arc0 + t * segment.length;
		}
	}
	return { stationM: Math.sqrt(bestDistanceSquared), arcM: bestArc };
}

/* ---------------------------------------------------------------- blending */

export type PerimeterField = {
	readonly entries: readonly { readonly arcM: number; readonly surface: TopSurface }[];
	readonly mode: InterpolationMode;
};

/**
 * Place each perimeter section on the perimeter and order them.
 *
 * A section is positioned where its cut line comes closest to a seaward edge, so
 * a cut drawn across a finger pier lands on the quay face it describes rather
 * than at an arbitrary chainage.
 */
export function buildPerimeterField(
	profiles: Readonly<Record<string, readonly ProfilePoint[]>>,
	plan: PlanGeometry,
	index: PerimeterIndex,
	mode: InterpolationMode,
	classification: ProfileClassificationSnapshot
): PerimeterField {
	const arcByProfile = new Map<string, number>();
	for (const cut of plan.sectionCuts) {
		let best: PerimeterHit | null = null;
		for (let step = 0; step <= 32; step++) {
			const t = step / 32;
			const x = cut.line[0][0] + (cut.line[cut.line.length - 1][0] - cut.line[0][0]) * t;
			const y = cut.line[0][1] + (cut.line[cut.line.length - 1][1] - cut.line[0][1]) * t;
			const hit = nearestPerimeter(index, x, y);
			if (!best || hit.stationM < best.stationM) best = hit;
		}
		if (best) arcByProfile.set(cut.profileId, best.arcM);
	}

	const entries: { arcM: number; surface: TopSurface }[] = [];
	for (const id of classification.perimeterIds) {
		const points = profiles[id];
		if (!points) continue;
		entries.push({
			arcM: arcByProfile.get(id) ?? Number.NaN,
			surface: topSurfaceFromProfile(id, points, classification.layerOverrides)
		});
	}
	if (entries.length === 0) {
		throw new Error(
			'No perimeter section reached the seaward toe, so no works surface can be built.'
		);
	}
	if (entries.length === 1 || entries.some((entry) => !Number.isFinite(entry.arcM))) {
		// Without a located cut for every perimeter section there is nothing to
		// blend between; the first section is carried around the whole perimeter.
		return { entries: [{ arcM: 0, surface: entries[0].surface }], mode: 'prismatic' };
	}
	entries.sort((a, b) => a.arcM - b.arcM);
	return { entries, mode };
}

export type PerimeterSample = {
	readonly z: number;
	readonly zone: ZoneId;
	/** Station of the cell, and the zone limits that applied to it. */
	readonly stationM: number;
	/** Position along the perimeter, so the caller can resample this profile. */
	readonly arcM: number;
	readonly armorEndStation: number;
	readonly crestEndStation: number;
};

/**
 * Blend the two neighbouring sections at a point on the perimeter.
 *
 * `morph` interpolates elevation *and* the zone limits linearly with distance
 * along the perimeter, so a face that changes batter between two sheets sweeps
 * smoothly. `prismatic` snaps to the nearest section, reproducing the classic
 * "the works are constant between cuts" reading of a drawing set.
 */
export function samplePerimeter(
	field: PerimeterField,
	arcM: number,
	station: number
): PerimeterSample | undefined {
	const { entries } = field;
	if (entries.length === 1 || field.mode === 'prismatic') {
		const nearest = entries.reduce((best, entry) =>
			Math.abs(entry.arcM - arcM) < Math.abs(best.arcM - arcM) ? entry : best
		);
		const z = sampleTopSurface(nearest.surface, station);
		if (z === undefined) return undefined;
		return {
			z,
			zone: zoneFor(station, nearest.surface.armorEndStation, nearest.surface.crestEndStation),
			stationM: station,
			arcM,
			armorEndStation: nearest.surface.armorEndStation,
			crestEndStation: nearest.surface.crestEndStation
		};
	}

	let high = entries.findIndex((entry) => entry.arcM >= arcM);
	if (high <= 0) high = high === 0 ? 1 : entries.length - 1;
	const low = high - 1;
	const a = entries[low];
	const b = entries[high];
	const span = b.arcM - a.arcM;
	const t = span <= 1e-9 ? 0 : Math.max(0, Math.min(1, (arcM - a.arcM) / span));

	const za = sampleTopSurface(a.surface, station);
	const zb = sampleTopSurface(b.surface, station);
	if (za === undefined && zb === undefined) return undefined;
	const z = za === undefined ? (zb as number) : zb === undefined ? za : lerp(za, zb, t);
	const armorEnd = lerp(a.surface.armorEndStation, b.surface.armorEndStation, t);
	const crestEnd = lerp(a.surface.crestEndStation, b.surface.crestEndStation, t);
	return {
		z,
		zone: zoneFor(station, armorEnd, crestEnd),
		stationM: station,
		arcM,
		armorEndStation: armorEnd,
		crestEndStation: crestEnd
	};
}

/** The section governing a point on the perimeter. */
export function nearestSurface(field: PerimeterField, arcM: number): TopSurface {
	return field.entries.reduce((best, entry) =>
		Math.abs(entry.arcM - arcM) < Math.abs(best.arcM - arcM) ? entry : best
	).surface;
}

function zoneFor(station: number, armorEnd: number, crestEnd: number): ZoneId {
	if (station <= armorEnd) return 'armor';
	if (station <= crestEnd) return 'crest';
	return 'platform';
}

/* --------------------------------------------------------------- structures */

export type StructureSampler = (x: number, y: number, bedZ: number) => number | undefined;

/**
 * Build the apron sampler for pre-existing embankments.
 *
 * Inside a crest footprint the structure stands at its crest level; outside it
 * falls away on the named face slope until it meets the bed.
 */
export function buildStructureSampler(
	structures: readonly PlanStructure[],
	slopes: Readonly<Record<string, SlopeRatio>>
): StructureSampler | null {
	const parts = structures
		.filter((structure) => structure.category === 'pre_existing')
		.flatMap((structure) => structure.parts)
		.map((part) => {
			const ring: Point2[] = [...part.polygon];
			const [firstX, firstY] = ring[0];
			const [lastX, lastY] = ring[ring.length - 1];
			if (firstX !== lastX || firstY !== lastY) ring.push([firstX, firstY]);
			// No invented batter: a structure falls back to the perimeter face slope,
			// and one with neither key resolved is dropped rather than guessed at.
			const ratio: SlopeRatio | undefined = slopes[part.faceSlopeKey] ?? slopes.seaward;
			return { ring, crestZ: part.crestZM, ratio };
		})
		.flatMap((part) =>
			Number.isFinite(part.crestZ) && part.ratio ? [{ ...part, ratio: part.ratio }] : []
		);
	if (parts.length === 0) return null;

	return (x, y, bedZ) => {
		let best: number | undefined;
		for (const part of parts) {
			const rise = part.crestZ - bedZ;
			if (rise <= 0) continue;
			let z: number;
			if (pointInPolygon(x, y, part.ring)) {
				z = part.crestZ;
			} else {
				const distance = distanceToPolyline(x, y, part.ring);
				const run = rise * (part.ratio.h / part.ratio.v);
				if (distance >= run) continue;
				z = part.crestZ - distance * (part.ratio.v / part.ratio.h);
			}
			if (best === undefined || z > best) best = z;
		}
		return best;
	};
}

/* ------------------------------------------------------------------ sampler */

/** Everything the integrator and the tessellator need, resolved once. */
export type SiteSampler = {
	readonly field: PerimeterField;
	readonly index: PerimeterIndex;
	readonly seabed: SeabedGrid;
	readonly params: SectionParameters;
	readonly plan: PlanGeometry;
	readonly structureAt: StructureSampler | null;
	readonly outline: readonly Point2[];
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
	/** How far seaward of the perimeter a below-grade band reaches. */
	readonly seawardReachM: number;
	bedAt(x: number, y: number): number;
	/** Finished design surface of the new works, or `undefined` outside them. */
	worksAt(x: number, y: number): PerimeterSample | undefined;
	/**
	 * Station measured from the perimeter, signed: positive inside the works,
	 * negative seaward of them. A sand key trench lives at negative stations.
	 */
	signedStationAt(x: number, y: number): { stationM: number; arcM: number; inside: boolean };
	/** Below-grade bands applicable at a point, with their invert on the datum. */
	subGradeAt(
		x: number,
		y: number
	): readonly { substrate: string; layer: string; invertM: number }[];
};

function closedRing(points: readonly Point2[]): Point2[] {
	const ring: Point2[] = [...points];
	if (ring.length === 0) return ring;
	const [firstX, firstY] = ring[0];
	const [lastX, lastY] = ring[ring.length - 1];
	if (firstX !== lastX || firstY !== lastY) ring.push([firstX, firstY]);
	return ring;
}

export function createSampler(model: StitchedModel): SiteSampler {
	const { plan, params, seabed, settings } = model;
	const outline = closedRing(plan.worksOutline);
	if (outline.length < 4) {
		throw new Error('The floor plan works outline needs at least three distinct corners.');
	}
	const index = buildPerimeterIndex(plan.seawardEdges);
	const field = buildPerimeterField(
		model.profiles,
		plan,
		index,
		settings.interpolation,
		model.classification
	);
	const structureAt = buildStructureSampler(plan.structures, params.slopes);
	const lagoons = (plan.lagoonPolygons ?? []).map((polygon) => closedRing(polygon));

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of outline) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}

	const seawardReachM = field.entries.reduce(
		(reach, entry) => Math.max(reach, entry.surface.seawardReachM),
		0
	);

	const signedStationAt = (x: number, y: number) => {
		const hit = nearestPerimeter(index, x, y);
		const inside = pointInPolygon(x, y, outline);
		return { stationM: inside ? hit.stationM : -hit.stationM, arcM: hit.arcM, inside };
	};

	return {
		field,
		index,
		seabed,
		params,
		plan,
		structureAt,
		outline,
		minX,
		maxX,
		minY,
		maxY,
		seawardReachM,
		signedStationAt,
		subGradeAt: (x, y) => {
			const { stationM, arcM } = signedStationAt(x, y);
			// Bands are detail, not shape: the nearest section governs rather than
			// a blend, so a trench invert is never interpolated into existence
			// between two sections that disagree about it.
			const surface = nearestSurface(field, arcM);
			const bands: { substrate: string; layer: string; invertM: number }[] = [];
			for (const band of surface.subGrade) {
				const invert = sampleBandInvert(band, stationM);
				if (invert === undefined) continue;
				bands.push({ substrate: band.substrate, layer: band.layer, invertM: invert });
			}
			return bands;
		},
		bedAt: (x, y) => sampleSeabed(seabed, x, y),
		worksAt: (x, y) => {
			if (x < minX || x > maxX || y < minY || y > maxY) return undefined;
			if (!pointInPolygon(x, y, outline)) return undefined;
			// A containment pond inside the bund is not yet filled ground.
			for (const lagoon of lagoons) {
				if (pointInPolygon(x, y, lagoon)) return undefined;
			}
			const hit = nearestPerimeter(index, x, y);
			return samplePerimeter(field, hit.arcM, hit.stationM);
		}
	};
}
