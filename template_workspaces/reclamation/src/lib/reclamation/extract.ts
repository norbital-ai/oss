/**
 * Document interpretation: raw files → `SiteData`.
 *
 * Every rule applied here is named, deterministic, and reported. Where a number
 * cannot be read from a document the engine records a `StitchAssumption` instead
 * of silently inventing a value, and where two documents disagree it records a
 * `StitchWarning` and states which document wins.
 *
 * Precedence, highest first:
 *   1. project overrides (typed by the engineer)
 *   2. cross-section document — every elevation and slope
 *   3. floor plan document — every plan XY extent and footprint
 *   4. bathymetry document — the existing bed under the works
 *   5. engine defaults — recorded as assumptions
 */

import {
	entitiesOnLayer,
	parseDxf,
	readLevelAnnotation,
	readSlopeAnnotation,
	type DxfDocument,
	type DxfEntity
} from './dxf.js';
import {
	boundingBox,
	distanceToPolyline,
	parseSlopeRatio,
	polygonArea,
	polylineLength
} from './math.js';
import {
	CAISSON_PROFILE_LAYERS,
	classifyProfiles,
	isSurfaceLayer,
	type LayerOverrides,
	type ProfileClassification
} from './profile-layers.js';
import {
	coercePolygon,
	decodeText,
	griddedSurveyFromPoints,
	parseJson,
	parseProfileCsv,
	parseXyz,
	type Xyz
} from './parse.js';
import type {
	DocumentFormat,
	DocumentKind,
	PlanGeometry,
	PlanSectionCut,
	PlanStructure,
	PlanStructurePart,
	Point2,
	ProfilePoint,
	SeabedGrid,
	SectionParameters,
	SiteData,
	SlopeRatio,
	StitchAssumption,
	StitchWarning
} from './types.js';

/**
 * Which CAD layers carry which meaning. Layer names are matched
 * case-insensitively; a layer that appears in no list is ignored and reported.
 */
export type LayerMapping = {
	/** Closed outline of the works at the toe — the reclamation extent. */
	readonly works: readonly string[];
	/** Closed polygon of the finished platform, used for area reporting. */
	readonly platform: readonly string[];
	readonly crest: readonly string[];
	readonly armor: readonly string[];
	/** Open polylines along the water-facing perimeter: quay face or revetment toe. */
	readonly toe: readonly string[];
	readonly shoreline: readonly string[];
	readonly land: readonly string[];
	readonly structure: readonly string[];
	/** Containment ponds inside the bund that carry no fill. */
	readonly lagoon: readonly string[];
	/** Neighbouring or future works, drawn for context only. */
	readonly context: readonly string[];
	readonly sectionCut: readonly string[];
	readonly annotation: readonly string[];
	readonly ignore: readonly string[];
};

export const DEFAULT_LAYER_MAPPING: LayerMapping = {
	works: ['WORKS', 'EXTENT', 'RECLAMATION', 'SITE'],
	platform: ['PLATFORM', 'FILL', 'SITE'],
	crest: ['CREST', 'BUND'],
	armor: ['ARMOR', 'ARMOUR', 'REVETMENT'],
	toe: ['TOE', 'QUAY', 'REVETMENT', 'SEAWARD'],
	shoreline: ['SHORELINE', 'COAST'],
	land: ['LAND', 'EXISTING', 'EXISTING_LAND'],
	structure: ['TBUND', 'STRUCTURE', 'EMBANKMENT', 'BREAKWATER'],
	lagoon: ['LAGOON', 'POND', 'CONTAINMENT'],
	context: ['CONTEXT', 'ADJACENT', 'FUTURE', 'PHASES', 'NEIGHBOUR', 'NEIGHBOR'],
	sectionCut: ['SECTIONS', 'SECTION', 'CUTS'],
	annotation: ['TEXT', 'ANNOTATION', 'LABELS', 'NOTES'],
	ignore: ['GRID', 'DIMS', 'DIMENSIONS', 'TITLE', 'FRAME', 'BORDER', 'DEFPOINTS', '0']
};

export type RawDocument = {
	readonly kind: DocumentKind;
	readonly assetId: string | null;
	readonly fileName: string | null;
	readonly mimeType: string | null;
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

/**
 * Engineer-supplied values that win over anything read from a document. Every
 * field is optional; a present field is recorded with source `override`.
 */
export type StitchOverrides = {
	readonly layerMapping?: Partial<LayerMapping>;
	readonly levelsM?: Partial<SectionParameters['levelsM']>;
	readonly slopes?: Readonly<Record<string, string>>;
	readonly dimensionsM?: Partial<SectionParameters['dimensionsM']>;
	readonly seawardFaceKind?: SectionParameters['seawardFaceKind'];
	readonly shorelineLengthM?: number;
	readonly datum?: string;
	/** Map a drawing set's own section vocabulary onto the engine's roles. */
	readonly profileLayers?: LayerOverrides;
};

/**
 * A calibration point the drawings must carry.
 *
 * These are the references the parser needs to place the site in space at all.
 * Without one of them the shape cannot be deduced, only guessed at, so the
 * stitch refuses rather than producing a solid that looks plausible and is not.
 */
export type CalibrationRequirement = {
	readonly id: string;
	readonly document: DocumentKind | 'project';
	readonly missing: string;
	readonly fix: string;
};

export class Ledger {
	readonly assumptions: StitchAssumption[] = [];
	readonly warnings: StitchWarning[] = [];
	readonly required: CalibrationRequirement[] = [];

	/** Record a missing calibration point. Collected, so one run reports them all. */
	require(requirement: CalibrationRequirement): void {
		if (this.required.some((entry) => entry.id === requirement.id)) return;
		this.required.push(requirement);
	}

	assume(assumption: StitchAssumption): void {
		if (this.assumptions.some((entry) => entry.id === assumption.id)) return;
		this.assumptions.push(assumption);
	}

	warn(code: string, message: string, severity: StitchWarning['severity'] = 'warning'): void {
		if (this.warnings.some((entry) => entry.code === code && entry.message === message)) return;
		this.warnings.push({ code, message, severity });
	}
}

export function detectFormat(document: RawDocument): DocumentFormat {
	const name = (document.fileName ?? '').toLowerCase();
	if (name.endsWith('.dxf')) return 'dxf';
	if (name.endsWith('.xyz') || name.endsWith('.pts') || name.endsWith('.txt')) return 'xyz';
	if (name.endsWith('.json') || name.endsWith('.geojson')) return 'json';
	if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
	const head = decodeText(document.bytes.subarray(0, 4096)).trimStart();
	if (head.startsWith('{')) return 'json';
	if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(head)) return 'dxf';
	if (/[,;\t]/.test(head.split(/\r?\n/)[0] ?? '')) return 'csv';
	if (/^[\s\-+0-9.eE]+$/.test((head.split(/\r?\n/)[1] ?? '').trim())) return 'xyz';
	return 'unsupported';
}

function mergeMapping(overrides?: Partial<LayerMapping>): LayerMapping {
	if (!overrides) return DEFAULT_LAYER_MAPPING;
	return { ...DEFAULT_LAYER_MAPPING, ...overrides };
}

function layerMatches(layer: string, candidates: readonly string[]): boolean {
	const normalised = layer.trim().toLowerCase();
	return candidates.some((candidate) => candidate.trim().toLowerCase() === normalised);
}

function entityRing(entity: DxfEntity): Point2[] {
	return entity.vertices.map(([x, y]) => [x, y] as Point2);
}

function meanY(points: readonly Point2[]): number {
	if (points.length === 0) return 0;
	return points.reduce((total, [, y]) => total + y, 0) / points.length;
}

/* ------------------------------------------------------------------ sections */

export type SectionExtraction = {
	readonly profiles: Record<string, ProfilePoint[]>;
	readonly annotations: readonly string[];
	readonly format: DocumentFormat;
	readonly summary: string;
};

function profilesFromDxf(document: DxfDocument): {
	profiles: Record<string, ProfilePoint[]>;
	annotations: string[];
} {
	const profiles: Record<string, ProfilePoint[]> = {};
	const annotations: string[] = [];
	for (const entity of document.entities) {
		if (entity.type === 'TEXT' || entity.type === 'MTEXT') {
			if (entity.text) annotations.push(entity.text);
			continue;
		}
		if (entity.type !== 'LWPOLYLINE' && entity.type !== 'POLYLINE' && entity.type !== 'LINE') {
			continue;
		}
		const profileId = entity.layer.trim() || 'section';
		const points = (profiles[profileId] ??= []);
		for (const [x, y] of entity.vertices) {
			points.push({ stationM: x, zCdM: y, layer: profileId.toLowerCase() });
		}
	}
	for (const points of Object.values(profiles)) points.sort((a, b) => a.stationM - b.stationM);
	return { profiles, annotations };
}

function profilesFromJson(payload: Record<string, unknown>): Record<string, ProfilePoint[]> {
	const raw = payload.profiles;
	const profiles: Record<string, ProfilePoint[]> = {};
	if (typeof raw !== 'object' || raw === null) return profiles;
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue;
		const points: ProfilePoint[] = [];
		for (const entry of value) {
			if (Array.isArray(entry)) {
				const station = Number(entry[0]);
				const z = Number(entry[1]);
				if (!Number.isFinite(station) || !Number.isFinite(z)) continue;
				points.push({
					stationM: station,
					zCdM: z,
					layer: String(entry[2] ?? 'grade').toLowerCase()
				});
				continue;
			}
			if (typeof entry === 'object' && entry !== null) {
				const record = entry as Record<string, unknown>;
				const station = Number(record.stationM ?? record.station_m ?? record.station);
				const z = Number(record.zCdM ?? record.z_cd_m ?? record.z);
				if (!Number.isFinite(station) || !Number.isFinite(z)) continue;
				points.push({
					stationM: station,
					zCdM: z,
					layer: String(record.layer ?? 'grade').toLowerCase()
				});
			}
		}
		points.sort((a, b) => a.stationM - b.stationM);
		if (points.length >= 2) profiles[id] = points;
	}
	return profiles;
}

export function extractSections(document: RawDocument, ledger: Ledger): SectionExtraction {
	const format = detectFormat(document);
	if (format === 'unsupported') {
		throw new Error(
			`Cross-section document "${document.fileName ?? 'upload'}" is not a DXF, CSV, or JSON export. ` +
				'DWG and PDF sheets have to be exported to DXF or digitised to the profile CSV schema first.'
		);
	}
	const text = decodeText(document.bytes);

	if (format === 'json') {
		const payload = parseJson(text);
		const profiles = profilesFromJson(payload);
		if (Object.keys(profiles).length === 0) {
			throw new Error('Cross-section JSON contained no readable `profiles` entries.');
		}
		return {
			profiles,
			annotations: Array.isArray(payload.materials) ? payload.materials.map(String) : [],
			format,
			summary: `${Object.keys(profiles).length} section profile(s) from JSON`
		};
	}

	if (format === 'dxf') {
		const parsed = parseDxf(text);
		const { profiles, annotations } = profilesFromDxf(parsed);
		if (Object.keys(profiles).length === 0) {
			throw new Error('Cross-section DXF contained no polyline geometry.');
		}
		ledger.assume({
			id: 'section-dxf-layer-per-profile',
			title: 'One DXF layer holds one section profile',
			detail:
				'Each polyline layer in the section DXF was read as one profile, with the polyline X read as station (0 at the seaward toe, increasing landward) and Y read as elevation on the project datum.',
			effect:
				'If the sheet places several sections on one layer, or draws them at a paper offset rather than in station/elevation space, the profiles are stitched at the wrong station and the solid is misplaced along the shore-normal axis.',
			source: 'cross_section'
		});
		return {
			profiles,
			annotations,
			format,
			summary: `${Object.keys(profiles).length} section profile(s) from DXF layers`
		};
	}

	const profiles = parseProfileCsv(text, 'section-1');
	if (Object.keys(profiles).length === 0) {
		throw new Error('Cross-section CSV contained no `station_m,z_cd_m,layer` rows.');
	}
	return {
		profiles,
		annotations: [],
		format,
		summary: `${Object.keys(profiles).length} section profile(s) from CSV`
	};
}

/* -------------------------------------------------------------- parameters */

/**
 * Exact layer lookup. Substring matching is deliberately not used: `crest_seaward`
 * would otherwise answer a request for `sea`, and a profile would silently pick
 * up the wrong elevation.
 */
function pointOnLayer(
	points: readonly ProfilePoint[],
	...layers: readonly string[]
): ProfilePoint | undefined {
	for (const layer of layers) {
		const found = points.find((point) => point.layer === layer);
		if (found) return found;
	}
	return undefined;
}

/**
 * Face batter of an internal structure, read from the section that crosses it.
 *
 * A face polyline usually breaks part-way up (a berm, or a change of material).
 * The segment that touches the bed is the one that governs how far the apron
 * reaches into the works, so that is the segment used.
 */
function deriveStructureFaceSlope(
	profiles: Readonly<Record<string, readonly ProfilePoint[]>>,
	structureIds: readonly string[]
): { ratio: SlopeRatio; profileId: string; layer: string } | undefined {
	for (const profileId of structureIds) {
		const points = profiles[profileId];
		if (!points) continue;
		const faceLayers = [
			...new Set(points.filter((point) => point.layer.includes('face')).map((point) => point.layer))
		];
		for (const layer of faceLayers) {
			const group = points
				.filter((point) => point.layer === layer)
				.sort((a, b) => a.stationM - b.stationM);
			if (group.length < 2) continue;
			let lowest = 0;
			for (let index = 1; index < group.length; index++) {
				if (group[index].zCdM < group[lowest].zCdM) lowest = index;
			}
			const neighbour = lowest === 0 ? group[1] : group[lowest - 1];
			const ratio = slopeFromSegment(group[lowest], neighbour);
			if (ratio) return { ratio, profileId, layer };
		}
	}
	return undefined;
}

function slopeFromSegment(from: ProfilePoint, to: ProfilePoint): SlopeRatio | undefined {
	const rise = Math.abs(to.zCdM - from.zCdM);
	const run = Math.abs(to.stationM - from.stationM);
	if (rise < 1e-6) return undefined;
	return { v: 1, h: run / rise };
}

/**
 * Derive levels, slopes, and dimensions from the section profiles.
 *
 * Slopes are read from the profile segment that governs the face, not from the
 * chord between its two ends: the seaward face slope comes from the first
 * segment leaving the toe, and a structure face slope comes from the segment in
 * contact with the bed.
 */
export function deriveParameters(
	sections: SectionExtraction,
	classification: ProfileClassification,
	overrides: StitchOverrides,
	ledger: Ledger
): SectionParameters {
	const layerOverrides = overrides.profileLayers;
	const perimeterEntries = classification.perimeterIds
		.filter((id) => sections.profiles[id])
		.map((id) => [id, sections.profiles[id]] as const);
	if (perimeterEntries.length === 0) {
		throw new Error('The cross-section document contained no usable section profile.');
	}
	if (!classification.explicit) {
		ledger.require({
			id: 'toe-marker',
			document: 'cross_section',
			missing: 'no section point on layer `toe` or `quay_crest`',
			fix: 'Label the seaward toe on every perimeter section. It is the origin of the station axis — without it the engine cannot tell where the face starts, nor a perimeter section from one drawn across an internal bund.'
		});
		ledger.assume({
			id: 'no-toe-label',
			title: 'No section names a toe, so every section is read as a perimeter section',
			detail: `None of the ${perimeterEntries.length} supplied section(s) carries a \`toe\` or \`quay_crest\` point, so there is no basis to tell a perimeter section from one drawn across an internal structure. All of them were wrapped around the perimeter, and station 0 is the first point of each.`,
			effect:
				'A section that actually crosses an internal bund is then applied to the shoreline, which distorts the face. Label the toe on each perimeter section, or list the toe layer under `profileLayers.toe` in the project overrides.',
			source: 'cross_section'
		});
	}
	const [perimeterId, perimeter] = perimeterEntries[0];
	const surface = perimeter.filter((point) => isSurfaceLayer(point.layer, layerOverrides));

	const toePoint = pointOnLayer(perimeter, 'toe') ?? surface[0];
	const crestSeaward = pointOnLayer(surface, 'crest_seaward', 'quay_crest', 'crest');
	const crestLandward = pointOnLayer(surface, 'crest_landward', 'caisson_landward');
	const armorCrest = pointOnLayer(surface, 'armor_crest', 'armour_crest');
	const hwmPoint = pointOnLayer(perimeter, 'hwm');
	const platformNames = (layerOverrides?.platform ?? []).map((entry) => entry.toLowerCase());
	const platformPoints = surface.filter(
		(point) => point.layer.includes('platform') || platformNames.includes(point.layer)
	);

	const toe = toePoint?.zCdM ?? Math.min(...surface.map((point) => point.zCdM));
	if (platformPoints.length === 0 && overrides.levelsM?.platform === undefined) {
		ledger.require({
			id: 'platform-marker',
			document: 'cross_section',
			missing: 'no section point on a `platform` layer',
			fix: 'Label the finished platform level on at least one perimeter section. It fixes the top of the fill; without it the engine can only take the highest point drawn, which may be a bund crest or a wall coping. A drawing set that names it differently can map it with `profileLayers.platform`, or state it outright with `levelsM.platform`.'
		});
	}
	const platform =
		platformPoints.length > 0
			? Math.max(...platformPoints.map((point) => point.zCdM))
			: Math.max(...surface.map((point) => point.zCdM));

	const annotationText = sections.annotations.join(' | ');
	const armorAnnotation = annotationText.match(
		/(?:armou?r|rock)[^|]*?(\d+(?:\.\d+)?)\s*m(?:\s*(?:thk|thick))?/i
	);
	const seaLevelPoint = pointOnLayer(perimeter, 'sea', 'swl', 'mwl');
	const interimPoint = pointOnLayer(perimeter, 'interim');

	if (!hwmPoint) {
		ledger.assume({
			id: 'no-hwm',
			title: 'No high-water mark on the section',
			detail:
				'The section carries no `hwm` point, so the engine does not split the seaward face at the water line.',
			effect: 'Face materials are drawn as one band from toe to crest instead of two.',
			source: 'default'
		});
	}
	if (!seaLevelPoint) {
		ledger.assume({
			id: 'sea-level-zero',
			title: 'Sea level taken as datum zero',
			detail:
				'No `sea` point exists on the section, so the rendered water plane sits at 0.0 on the project datum.',
			effect: 'The water plane is drawn at the wrong height if the datum is not a chart datum.',
			source: 'default'
		});
	}
	if (!interimPoint) {
		ledger.assume({
			id: 'material-change-at-zero',
			title: 'Fill material changes at datum zero',
			detail:
				'Below 0.0 the platform column is priced as dredged and excavated material; above 0.0 it is priced as sand and good earth. No `interim` point on the section states a different level.',
			effect:
				'The split between dredged fill and sand fill quantities moves with this level; a wrong level moves cost between the two rates without changing the total volume.',
			source: 'default'
		});
	}

	const seawardIndex = surface.findIndex((point) => point === toePoint);
	const seawardNext = seawardIndex >= 0 ? surface[seawardIndex + 1] : surface[1];
	const seawardFromProfile =
		toePoint && seawardNext ? slopeFromSegment(toePoint, seawardNext) : undefined;

	const slopes: Record<string, SlopeRatio> = {};
	if (seawardFromProfile) slopes.seaward = seawardFromProfile;

	const bundToe = pointOnLayer(perimeter, 'bund_landward_toe', 'inner_fill');
	if (crestLandward && bundToe) {
		const inner = slopeFromSegment(crestLandward, bundToe);
		if (inner) slopes.inner_fill = inner;
	}
	const sandKeyPoints = perimeter.filter((point) => point.layer.includes('sand_key'));
	if (sandKeyPoints.length >= 2 && toePoint) {
		const width = Math.abs(
			sandKeyPoints[sandKeyPoints.length - 1].stationM - sandKeyPoints[0].stationM
		);
		const depth = Math.abs(toePoint.zCdM - sandKeyPoints[0].zCdM);
		ledger.assume({
			id: 'sand-key-trench',
			title: `Sand key read as a ${width.toFixed(1)} m × ${depth.toFixed(1)} m trench`,
			detail:
				'The `sand_key` points on the section were read as the trench footprint under the toe, and priced as a rectangular prism along the perimeter. No side batter is assumed: none is dimensioned, and none is needed for a prism.',
			effect: 'A trench with battered sides holds less, so the sand key line is an upper bound.',
			source: 'cross_section'
		});
	}
	const structureFace = deriveStructureFaceSlope(sections.profiles, classification.structureIds);
	if (structureFace) {
		slopes.structure_face = structureFace.ratio;
		ledger.assume({
			id: 'structure-face-from-section',
			title: `Structure faces battered at 1V:${(structureFace.ratio.h / structureFace.ratio.v).toFixed(2)}H`,
			detail: `Taken from the bed-contact segment of layer \`${structureFace.layer}\` on section "${structureFace.profileId}" and applied to every pre-existing structure on the plan.`,
			effect:
				'Structures whose real faces are steeper or flatter displace a different amount of new fill, which moves the platform fill quantities.',
			source: 'cross_section'
		});
	}

	for (const [key, value] of Object.entries(overrides.slopes ?? {})) {
		try {
			slopes[key] = parseSlopeRatio(value);
		} catch {
			ledger.warn('override-slope', `Ignored unparseable slope override \`${key}: ${value}\`.`);
		}
	}
	for (const annotation of sections.annotations) {
		const slopeText = readSlopeAnnotation(annotation);
		if (!slopeText) continue;
		if (!slopes.seaward) {
			slopes.seaward = parseSlopeRatio(slopeText);
			ledger.assume({
				id: 'slope-from-annotation',
				title: `Seaward face slope read from the annotation "${annotation.trim()}"`,
				detail: 'No sloped segment leaves the toe, so the face slope came from a text callout.',
				effect:
					'A callout that describes a different face gives the whole perimeter the wrong batter.',
				source: 'cross_section'
			});
		}
	}
	if (!slopes.seaward) {
		throw new Error(
			'Could not determine the seaward face slope: the perimeter section has no segment leaving ' +
				'the toe and no `1V:nH` callout. Add one, or set `slopes.seaward` in the project overrides.'
		);
	}

	const crestWidth =
		crestLandward && crestSeaward
			? Math.abs(crestLandward.stationM - crestSeaward.stationM)
			: undefined;
	const armorCrestWidth =
		armorCrest && crestSeaward ? Math.abs(armorCrest.stationM - crestSeaward.stationM) : undefined;

	const looksLikeCaisson = perimeter.some((point) =>
		CAISSON_PROFILE_LAYERS.some((layer) => point.layer.includes(layer))
	);
	let armorThickness = overrides.dimensionsM?.armorThickness;
	if (armorThickness === undefined && armorAnnotation) {
		armorThickness = Number(armorAnnotation[1]);
	}
	if (armorThickness === undefined) {
		if (looksLikeCaisson) {
			armorThickness = 0;
			ledger.assume({
				id: 'caisson-no-armor',
				title: 'Vertical quay face carries no rock armour',
				detail:
					'The perimeter section names a caisson, quay, or wall layer, so the engine models an earth-retaining face with no armour blanket.',
				effect: 'Rock armour and geofabric quantities are zero.',
				source: 'cross_section'
			});
		} else if (armorCrestWidth !== undefined && armorCrestWidth > 0) {
			// Rock-manual two-layer relation: a crest of n = 3 nominal diameters and
			// an armour layer of n = 2 share the same k∆·Dn50, so t = 2·B / 3. This
			// derives the thickness from a dimension that *is* on the sheet instead
			// of inventing one.
			armorThickness = (2 * armorCrestWidth) / 3;
			ledger.assume({
				id: 'armor-thickness-from-crest-width',
				title: `Rock armour thickness taken as ${armorThickness.toFixed(2)} m`,
				detail: `Armour thickness is measured perpendicular to the face and cannot be read off a design polyline. It was derived from the ${armorCrestWidth.toFixed(2)} m armour crest width using the standard two-layer relation t = 2B/3 (crest of three nominal diameters, armour layer of two).`,
				effect:
					'Armour volume and geofabric area scale linearly with this number — the largest single lever on the armour line. Set `dimensionsM.armorThickness` in the project overrides once the sheet is read.',
				source: 'cross_section'
			});
		} else {
			armorThickness = 0;
			ledger.warn(
				'armor-thickness-unknown',
				'Rock armour thickness is not stated on the section, not annotated, and not in the project overrides, and no armour crest width is dimensioned to derive it from. The armour and geofabric lines are zero rather than invented — set `dimensionsM.armorThickness` to quantify them.',
				'error'
			);
		}
	}

	const dredgedRockThickness = overrides.dimensionsM?.dredgedRockThickness ?? 0;
	if (dredgedRockThickness === 0) {
		ledger.assume({
			id: 'no-dredged-rock',
			title: 'No dredged rock foundation modelled',
			detail:
				'No foundation-rock thickness was stated on the section or in the overrides, so the dredged rock line is zero rather than estimated.',
			effect: 'A real rock mattress under the toe is missing from both the solid and the estimate.',
			source: 'default'
		});
	}

	const sandKeyWidth =
		overrides.dimensionsM?.sandKeyWidth ??
		(sandKeyPoints.length >= 2
			? Math.abs(sandKeyPoints[sandKeyPoints.length - 1].stationM - sandKeyPoints[0].stationM)
			: 0);
	const sandKeyDepth =
		overrides.dimensionsM?.sandKeyDepth ??
		(sandKeyPoints.length >= 1 ? Math.abs(toe - sandKeyPoints[0].zCdM) : 0);

	// Typology follows the shape of the face, not the armour line: a face can be
	// unquantified — thickness unknown — and still be a rock slope.
	const seawardRun = slopes.seaward ? slopes.seaward.h / slopes.seaward.v : 0;
	const seawardFaceKind =
		overrides.seawardFaceKind ?? (looksLikeCaisson || seawardRun < 0.5 ? 'caisson' : 'revetment');

	if (perimeterEntries.length > 1) {
		ledger.assume({
			id: 'levels-from-first-perimeter-section',
			title: `Levels and slopes taken from section "${perimeterId}"`,
			detail: `${perimeterEntries.length} perimeter sections were supplied; the first one governs the levels, slopes, crest width, and armour dimensions used everywhere.`,
			effect:
				'Where another perimeter section has a different toe level or batter, its own geometry is still drawn, but the quantities keyed to levels and dimensions follow the first section.',
			source: 'cross_section'
		});
	}

	return {
		levelsM: {
			toe: overrides.levelsM?.toe ?? toe,
			platform: overrides.levelsM?.platform ?? platform,
			...(hwmPoint || overrides.levelsM?.hwm !== undefined
				? { hwm: overrides.levelsM?.hwm ?? hwmPoint?.zCdM }
				: {}),
			sea: overrides.levelsM?.sea ?? seaLevelPoint?.zCdM ?? 0,
			interim: overrides.levelsM?.interim ?? interimPoint?.zCdM ?? 0
		},
		slopes,
		dimensionsM: {
			...(crestWidth === undefined ? {} : { crestWidth }),
			...(armorCrestWidth === undefined ? {} : { armorCrest: armorCrestWidth }),
			armorThickness,
			dredgedRockThickness,
			sandKeyWidth,
			sandKeyDepth,
			...(overrides.dimensionsM?.caissonWidth === undefined
				? {}
				: { caissonWidth: overrides.dimensionsM.caissonWidth })
		},
		seawardFaceKind,
		materials: sections.annotations.length > 0 ? sections.annotations : undefined
	};
}

/* -------------------------------------------------------------------- plan */

function planFromJsonPayload(payload: Record<string, unknown>, ledger: Ledger): PlanGeometry {
	const outline =
		coercePolygon(payload.works_outline ?? payload.worksOutline) ??
		coercePolygon(payload.platform_top_polygon ?? payload.platformTopPolygon);
	if (!outline) {
		throw new Error(
			'Floor plan JSON is missing `works_outline` (the reclamation extent at the toe).'
		);
	}
	const platform =
		coercePolygon(payload.platform_top_polygon ?? payload.platformTopPolygon) ?? outline;

	const rawEdges =
		payload.seaward_edges ?? payload.seawardEdges ?? payload.toe_line ?? payload.toeLine;
	let seawardEdges: Point2[][] = [];
	if (Array.isArray(rawEdges) && Array.isArray(rawEdges[0]) && Array.isArray(rawEdges[0][0])) {
		seawardEdges = rawEdges.flatMap((entry) => {
			const polyline = coercePolygon(entry);
			return polyline ? [polyline] : [];
		});
	} else {
		const single = coercePolygon(rawEdges);
		if (single) seawardEdges = [single];
	}
	if (seawardEdges.length === 0) {
		seawardEdges = [[...outline, outline[0]]];
		ledger.require({
			id: 'seaward-edges',
			document: 'floor_plan',
			missing: 'no `seaward_edges` in the plan JSON',
			fix: 'List the water-facing chains of the outline under `seaward_edges`. Station 0 is measured from them. For a wholly offshore site, repeat the whole outline.'
		});
	}

	const structuresRaw = Array.isArray(payload.structures) ? payload.structures : [];
	const structures: PlanStructure[] = [];
	for (const entry of structuresRaw) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const partsRaw = Array.isArray(record.parts) ? record.parts : [];
		const parts: PlanStructurePart[] = [];
		for (const partEntry of partsRaw) {
			if (typeof partEntry !== 'object' || partEntry === null) continue;
			const part = partEntry as Record<string, unknown>;
			const polygon = coercePolygon(part.polygon);
			if (!polygon) continue;
			parts.push({
				id: String(part.id ?? `part-${parts.length + 1}`),
				polygon,
				crestZM: Number(part.crestZM ?? part.crest_z_m ?? Number.NaN),
				faceSlopeKey: String(part.faceSlopeKey ?? part.face_slope_key ?? 'seaward'),
				...(part.faceSlopeKeySeaward || part.face_slope_key_seaward
					? {
							faceSlopeKeySeaward: String(part.faceSlopeKeySeaward ?? part.face_slope_key_seaward)
						}
					: {})
			});
		}
		if (parts.length === 0) continue;
		structures.push({
			id: String(record.id ?? `structure-${structures.length + 1}`),
			category: record.category === 'new_works' ? 'new_works' : 'pre_existing',
			parts
		});
	}

	const cuts: PlanSectionCut[] = [];
	const cutsRaw = payload.section_cuts ?? payload.sectionCuts;
	if (typeof cutsRaw === 'object' && cutsRaw !== null) {
		for (const [id, value] of Object.entries(cutsRaw as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null) continue;
			const record = value as Record<string, unknown>;
			const line = coercePolygon(record.line);
			if (!line || line.length < 2) continue;
			cuts.push({
				id,
				profileId: String(record.profile ?? record.profileId ?? id),
				line,
				...(record.type ? { type: String(record.type) } : {}),
				chainageM: Number(record.chainage_m ?? record.chainageM ?? (line[0][0] + line[1][0]) / 2)
			});
		}
	}

	const lagoonsRaw = payload.lagoon_polygons ?? payload.lagoonPolygons;
	const lagoonPolygons = Array.isArray(lagoonsRaw)
		? lagoonsRaw.flatMap((entry) => {
				const polygon = coercePolygon(entry);
				return polygon && polygon.length >= 3 ? [polygon] : [];
			})
		: [];

	const contextRaw = payload.context_polygons ?? payload.contextPolygons;
	const contextPolygons = Array.isArray(contextRaw)
		? contextRaw.flatMap((entry, index) => {
				const direct = coercePolygon(entry);
				if (direct && direct.length >= 3) {
					return [{ label: `Adjacent works ${index + 1}`, polygon: direct }];
				}
				if (typeof entry !== 'object' || entry === null) return [];
				const record = entry as Record<string, unknown>;
				const polygon = coercePolygon(record.polygon);
				if (!polygon || polygon.length < 3) return [];
				return [{ label: String(record.label ?? `Adjacent works ${index + 1}`), polygon }];
			})
		: [];

	const measuredPerimeter = seawardEdges.reduce((total, edge) => total + polylineLength(edge), 0);
	const shorelineLength = Number(payload.shoreline_length_m ?? payload.shorelineLengthM);

	return {
		shorelineLengthM: Number.isFinite(shorelineLength) ? shorelineLength : measuredPerimeter,
		worksOutline: outline,
		seawardEdges,
		platformTopPolygon: platform,
		...(coercePolygon(payload.crest_polygon ?? payload.crestPolygon)
			? { crestPolygon: coercePolygon(payload.crest_polygon ?? payload.crestPolygon) }
			: {}),
		...(coercePolygon(payload.existing_shoreline ?? payload.existingShoreline)
			? {
					existingShoreline: coercePolygon(payload.existing_shoreline ?? payload.existingShoreline)
				}
			: {}),
		...(coercePolygon(payload.existing_land_polygon ?? payload.existingLandPolygon)
			? {
					existingLandPolygon: coercePolygon(
						payload.existing_land_polygon ?? payload.existingLandPolygon
					)
				}
			: {}),
		...(Number.isFinite(Number(payload.existing_land_level_cd_m ?? payload.existingLandLevelM))
			? {
					existingLandLevelM: Number(payload.existing_land_level_cd_m ?? payload.existingLandLevelM)
				}
			: {}),
		...(lagoonPolygons.length > 0 ? { lagoonPolygons } : {}),
		...(contextPolygons.length > 0 ? { contextPolygons } : {}),
		structures,
		sectionCuts: cuts
	};
}

/** Nearest text label to a closed ring, used to name context polygons. */
function nearestLabel(entity: DxfEntity, annotations: readonly DxfEntity[]): string | null {
	if (entity.vertices.length === 0) return null;
	let cx = 0;
	let cy = 0;
	for (const [x, y] of entity.vertices) {
		cx += x;
		cy += y;
	}
	cx /= entity.vertices.length;
	cy /= entity.vertices.length;

	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const annotation of annotations) {
		if (!annotation.text || annotation.vertices.length === 0) continue;
		const [ax, ay] = annotation.vertices[0];
		const distance = Math.hypot(ax - cx, ay - cy);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = annotation.text.trim();
		}
	}
	return best;
}

function namedCuts(
	cutEntities: readonly DxfEntity[],
	annotations: readonly DxfEntity[],
	profileIds: readonly string[],
	ledger: Ledger
): PlanSectionCut[] {
	const cuts: PlanSectionCut[] = [];
	for (const entity of cutEntities) {
		const line = entityRing(entity);
		if (line.length < 2) continue;
		const start = line[0];
		const end = line[line.length - 1];
		const midpoint: Point2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];

		let label: string | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const annotation of annotations) {
			const text = annotation.text ?? '';
			const match = text.match(/SEC(?:TION)?\.?\s*([A-Za-z0-9]+(?:\s*[-–]\s*[A-Za-z0-9]+)?)/i);
			if (!match || annotation.vertices.length === 0) continue;
			const [ax, ay] = annotation.vertices[0];
			const distance = Math.min(
				Math.hypot(ax - start[0], ay - start[1]),
				Math.hypot(ax - end[0], ay - end[1]),
				Math.hypot(ax - midpoint[0], ay - midpoint[1])
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				label = match[1].replace(/\s+/g, '');
			}
		}

		const id = label ?? `cut-${cuts.length + 1}`;
		const profileId =
			profileIds.find(
				(candidate) => candidate.replace(/[^0-9a-z]/gi, '') === id.replace(/[^0-9a-z]/gi, '')
			) ?? id;
		cuts.push({
			id,
			profileId,
			line,
			chainageM: midpoint[0]
		});
	}
	if (cuts.length > 0 && cuts.every((cut) => cut.id.startsWith('cut-'))) {
		ledger.assume({
			id: 'unlabelled-section-cuts',
			title: 'Section cut lines carry no `SEC x-x` label',
			detail:
				'The cut lines on the plan were numbered in file order because no nearby text matched a section name.',
			effect:
				'A profile can be lofted at the wrong chainage. Label the cuts on the plan, or supply the plan as JSON with an explicit `section_cuts` map.',
			source: 'floor_plan'
		});
	}
	return cuts;
}

function planFromDxf(
	parsed: DxfDocument,
	mapping: LayerMapping,
	profileIds: readonly string[],
	platformLevel: number,
	structureCrestLevel: number,
	structureSlopeKey: string,
	ledger: Ledger
): PlanGeometry {
	const rings = parsed.entities.filter(
		(entity) => entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE'
	);
	const lines = parsed.entities.filter((entity) => entity.type === 'LINE');
	const annotations = parsed.entities.filter(
		(entity) => entity.type === 'TEXT' || entity.type === 'MTEXT'
	);

	const largestRing = (candidates: readonly DxfEntity[]): Point2[] | undefined =>
		candidates.length === 0
			? undefined
			: entityRing(
					candidates.reduce((largest, candidate) =>
						polygonArea(entityRing(candidate)) > polygonArea(entityRing(largest))
							? candidate
							: largest
					)
				);

	const outline = largestRing(rings.filter((entity) => layerMatches(entity.layer, mapping.works)));
	const platformRing = largestRing(
		rings.filter((entity) => layerMatches(entity.layer, mapping.platform))
	);
	const worksOutline = outline ?? platformRing;
	if (!worksOutline) {
		throw new Error(
			`Floor plan DXF has no closed polyline on a works layer (${mapping.works.join(', ')}) ` +
				'or a platform layer. Adjust the project layer mapping or supply the plan as JSON.'
		);
	}
	const platform = platformRing ?? worksOutline;
	if (!outline) {
		ledger.assume({
			id: 'outline-from-platform',
			title: 'The works outline was taken from the platform polygon',
			detail:
				'No polygon on a works layer describes the reclamation extent at the toe, so the platform polygon was used for both.',
			effect:
				'The seaward face is then built landward of the platform edge instead of outside it, so the footprint is understated by the face run and the platform loses a band of finished area.',
			source: 'floor_plan'
		});
	}

	const armorRings = rings.filter((entity) => layerMatches(entity.layer, mapping.armor));
	const crestRings = rings.filter((entity) => layerMatches(entity.layer, mapping.crest));
	const sortedSeaward = [...armorRings, ...crestRings].sort(
		(a, b) => meanY(entityRing(b)) - meanY(entityRing(a))
	);
	const armorPolygon = sortedSeaward[0] ? entityRing(sortedSeaward[0]) : undefined;
	const crestPolygon = sortedSeaward[1] ? entityRing(sortedSeaward[1]) : undefined;
	if (sortedSeaward.length >= 2 && crestRings.length === 0) {
		ledger.assume({
			id: 'revetment-band-split',
			title: 'Revetment bands split by distance from the sea',
			detail:
				'Two closed bands share the revetment layer, so the seaward band was read as the armour face and the landward band as the bund crest.',
			effect:
				'If the bands are drawn in the other order the crest and the armour face swap, which moves the crest width and the armour area.',
			source: 'floor_plan'
		});
	}

	// Seaward edges: every polyline on a toe or quay layer. Several are expected —
	// a finger pier has one per face — so they are collected, not reduced to one.
	const seawardEdges: Point2[][] = [...lines, ...rings]
		.filter((entity) => layerMatches(entity.layer, mapping.toe))
		.map((entity) => entityRing(entity))
		.filter((edge) => edge.length >= 2);
	if (seawardEdges.length === 0) {
		seawardEdges.push([...worksOutline, worksOutline[0]]);
		ledger.require({
			id: 'seaward-edges',
			document: 'floor_plan',
			missing: `no polyline on a toe or quay layer (${mapping.toe.join(', ')})`,
			fix: 'Trace the water-facing part of the outline onto a TOE or QUAY layer. Station 0 is measured from it, so without it the engine cannot tell a revetment from a boundary against existing land. For a wholly offshore site, trace the entire outline.'
		});
	}

	const shorelineCandidates = lines.filter((entity) =>
		layerMatches(entity.layer, mapping.shoreline)
	);
	const existingShoreline = shorelineCandidates.length
		? entityRing(
				shorelineCandidates.reduce((longest, candidate) =>
					polylineLength(entityRing(candidate)) > polylineLength(entityRing(longest))
						? candidate
						: longest
				)
			)
		: undefined;

	const landRings = rings.filter((entity) => layerMatches(entity.layer, mapping.land));
	const existingLandPolygon = landRings.length ? entityRing(landRings[0]) : undefined;

	const structureParts: PlanStructurePart[] = rings
		.filter((entity) => layerMatches(entity.layer, mapping.structure))
		.map((entity, index) => ({
			id: `${entity.layer.toLowerCase()}-${index + 1}`,
			polygon: entityRing(entity),
			crestZM: structureCrestLevel,
			faceSlopeKey: structureSlopeKey
		}));

	const contextPolygons = rings
		.filter((entity) => layerMatches(entity.layer, mapping.context))
		.map((entity, index) => ({
			label: nearestLabel(entity, annotations) ?? `Adjacent works ${index + 1}`,
			polygon: entityRing(entity)
		}))
		.filter((entry) => entry.polygon.length >= 3);

	const lagoonPolygons = rings
		.filter((entity) => layerMatches(entity.layer, mapping.lagoon))
		.map((entity) => entityRing(entity))
		.filter((polygon) => polygon.length >= 3);
	if (lagoonPolygons.length > 0) {
		ledger.assume({
			id: 'lagoon-carries-no-fill',
			title: `${lagoonPolygons.length} containment pond(s) carry no fill`,
			detail:
				'The pond footprints on the plan are treated as open water inside the bund, so no fill volume is priced under them.',
			effect:
				'If the ponds are closed and filled later in the programme, the platform fill quantity is understated by their area times the fill depth.',
			source: 'floor_plan'
		});
	}

	const cutEntities = lines.filter((entity) => layerMatches(entity.layer, mapping.sectionCut));
	const cuts = namedCuts(cutEntities, annotations, profileIds, ledger);

	const unmapped = new Set<string>();
	for (const entity of parsed.entities) {
		const known =
			layerMatches(entity.layer, mapping.works) ||
			layerMatches(entity.layer, mapping.platform) ||
			layerMatches(entity.layer, mapping.crest) ||
			layerMatches(entity.layer, mapping.armor) ||
			layerMatches(entity.layer, mapping.toe) ||
			layerMatches(entity.layer, mapping.shoreline) ||
			layerMatches(entity.layer, mapping.land) ||
			layerMatches(entity.layer, mapping.structure) ||
			layerMatches(entity.layer, mapping.lagoon) ||
			layerMatches(entity.layer, mapping.context) ||
			layerMatches(entity.layer, mapping.sectionCut) ||
			layerMatches(entity.layer, mapping.annotation) ||
			layerMatches(entity.layer, mapping.ignore);
		if (!known) unmapped.add(entity.layer);
	}
	if (unmapped.size > 0) {
		ledger.warn(
			'unmapped-plan-layers',
			`Floor plan layers not used by the model: ${[...unmapped].sort().join(', ')}. Add them to the project layer mapping if they carry geometry.`,
			'info'
		);
	}

	for (const annotation of annotations) {
		const text = annotation.text ?? '';
		const level = readLevelAnnotation(text);
		if (level === null) continue;
		if (/platform/i.test(text) && Math.abs(level - platformLevel) > 0.25) {
			ledger.warn(
				'plan-level-conflict',
				`The floor plan annotates the platform at ${level} m but the section sheet gives ${platformLevel} m. The section sheet governs elevations.`
			);
		}
	}

	return {
		shorelineLengthM: seawardEdges.reduce((total, edge) => total + polylineLength(edge), 0),
		worksOutline,
		seawardEdges,
		platformTopPolygon: platform,
		...(crestPolygon ? { crestPolygon } : {}),
		...(armorPolygon ? { armorPolygon } : {}),
		...(existingShoreline ? { existingShoreline } : {}),
		...(existingLandPolygon ? { existingLandPolygon } : {}),
		...(lagoonPolygons.length > 0 ? { lagoonPolygons } : {}),
		...(contextPolygons.length > 0 ? { contextPolygons } : {}),
		structures: structureParts.length
			? [{ id: 'plan-structures', category: 'pre_existing', parts: structureParts }]
			: [],
		sectionCuts: cuts
	};
}

export function extractPlan(
	document: RawDocument,
	overrides: StitchOverrides,
	params: SectionParameters,
	profiles: Readonly<Record<string, readonly ProfilePoint[]>>,
	classification: ProfileClassification,
	ledger: Ledger
): { plan: PlanGeometry; format: DocumentFormat; summary: string } {
	const format = detectFormat(document);
	if (format === 'unsupported' || format === 'xyz' || format === 'csv') {
		throw new Error(
			`Floor plan document "${document.fileName ?? 'upload'}" must be a DXF export or a plan JSON. ` +
				'DWG has to be exported to DXF first.'
		);
	}
	const text = decodeText(document.bytes);
	if (format === 'json') {
		const plan = planFromJsonPayload(parseJson(text), ledger);
		return { plan, format, summary: `plan JSON · ${plan.structures.length} structure group(s)` };
	}

	const parsed = parseDxf(text);
	if (parsed.insUnits !== null && parsed.insUnits !== 6) {
		ledger.warn(
			'plan-units',
			`The floor plan DXF declares $INSUNITS ${parsed.insUnits}; the engine reads every coordinate as metres.`
		);
	}
	// A structure's crest comes from the section that crosses that structure, not
	// from the perimeter crest: those are different levels on most sites.
	const structureCrest = classification.structureIds
		.flatMap((id) => profiles[id] ?? [])
		.filter((point) => point.layer.includes('crest'))
		.reduce((highest, point) => Math.max(highest, point.zCdM), Number.NEGATIVE_INFINITY);
	const structureCrestLevel = Number.isFinite(structureCrest)
		? structureCrest
		: params.levelsM.platform;
	const structureSlopeKey = params.slopes.tbund_face
		? 'tbund_face'
		: params.slopes.structure_face
			? 'structure_face'
			: 'seaward';

	const plan = planFromDxf(
		parsed,
		mergeMapping(overrides.layerMapping),
		Object.keys(profiles),
		params.levelsM.platform,
		structureCrestLevel,
		structureSlopeKey,
		ledger
	);
	if (plan.structures.length > 0) {
		ledger.assume({
			id: 'structure-crest-from-sections',
			title: `Existing structures crested at ${structureCrestLevel.toFixed(2)} m on face slope ${structureSlopeKey}`,
			detail:
				'A plan is two-dimensional, so a structure footprint carries no crest level. The engine used the highest `crest` point across the supplied sections, and the named face slope, for every structure on the plan.',
			effect:
				'Structures with different crest heights are all drawn at one level, which changes how much new fill they displace.',
			source: 'floor_plan'
		});
	}
	const skipped = Object.entries(parsed.skipped);
	if (skipped.length > 0) {
		ledger.warn(
			'plan-entities-skipped',
			`Undecoded floor plan entities: ${skipped.map(([type, count]) => `${type}×${count}`).join(', ')}. Blocks, splines, and hatches are not read.`,
			'info'
		);
	}
	return {
		plan,
		format,
		summary: `${parsed.entities.length} DXF entities across ${parsed.layers.length} layer(s)`
	};
}

/* --------------------------------------------------------------- bathymetry */

function soundingsFrom(document: RawDocument): { points: Xyz[]; format: DocumentFormat } {
	const format = detectFormat(document);
	const text = decodeText(document.bytes);

	let points: Xyz[];
	if (format === 'dxf') {
		const parsed = parseDxf(text);
		points = parsed.entities
			.filter((entity) => entity.type === 'POINT')
			.flatMap((entity) => entity.vertices.map(([x, y, z]) => ({ x, y, z })));
		if (points.length === 0) {
			throw new Error('Bathymetry DXF contained no POINT entities carrying a Z value.');
		}
	} else if (format === 'json') {
		const payload = parseJson(text);
		const raw = Array.isArray(payload.points) ? payload.points : [];
		points = raw.flatMap((entry) => {
			if (!Array.isArray(entry) || entry.length < 3) return [];
			return [{ x: Number(entry[0]), y: Number(entry[1]), z: Number(entry[2]) }];
		});
	} else {
		points = parseXyz(text);
	}
	return { points, format };
}

/**
 * Grid the survey.
 *
 * Several bathymetry documents can be supplied — a base survey plus an infill,
 * or one file per block. Their soundings are pooled before gridding, so a later
 * survey densifies the bed rather than replacing it.
 */
export function extractSeabed(
	documents: readonly RawDocument[],
	fallbackZ: number,
	maxCells: number,
	ledger: Ledger
): { grid: SeabedGrid; format: DocumentFormat; summary: string } {
	const decoded = documents.map((document) => soundingsFrom(document));
	const points = decoded.flatMap((entry) => entry.points);
	const format = decoded[0]?.format ?? 'unsupported';
	if (points.length === 0) {
		throw new Error('Bathymetry document contained no readable soundings.');
	}
	if (documents.length > 1) {
		ledger.assume({
			id: 'bathymetry-pooled',
			title: `${documents.length} bathymetry documents pooled into one bed`,
			detail:
				'Soundings from every supplied survey were pooled before gridding; where two surveys overlap, a cell takes the mean of the points inside it.',
			effect:
				'Surveys flown at different dates or datums are averaged rather than sequenced, so a re-survey after dredging blends with the original instead of superseding it.',
			source: 'bathymetry'
		});
	}

	const survey = griddedSurveyFromPoints(points, { maxCells, fallbackZ });
	if (survey.appliedSpacingM > survey.requestedSpacingM * 1.01) {
		ledger.warn(
			'bathymetry-downsampled',
			`The survey was resampled from ${survey.requestedSpacingM.toFixed(2)} m to ${survey.appliedSpacingM.toFixed(2)} m spacing to stay under ${maxCells.toLocaleString()} grid cells. Fill volumes are integrated on the coarser bed.`
		);
	}
	if (survey.filledCells > 0) {
		const share = (survey.filledCells / (survey.grid.nx * survey.grid.ny)) * 100;
		ledger.assume({
			id: 'bathymetry-hole-fill',
			title: `${share.toFixed(1)}% of bed cells interpolated`,
			detail: `Cells with no sounding were filled from their neighbours over three passes; anything still empty was set to the toe level (${fallbackZ.toFixed(2)} m).`,
			effect:
				'Fill depth over an unsurveyed pocket is only as good as the surrounding soundings, so volumes there carry the interpolation error.',
			source: 'bathymetry'
		});
	}

	return {
		grid: survey.grid,
		format,
		summary: `${survey.pointCount.toLocaleString()} soundings → ${survey.grid.nx}×${survey.grid.ny} grid at ${survey.appliedSpacingM.toFixed(2)} m`
	};
}

/* ---------------------------------------------------------------- assembly */

export type ExtractionResult = {
	readonly data: SiteData;
	readonly classification: ProfileClassification;
	readonly formats: Readonly<Record<DocumentKind, DocumentFormat>>;
	readonly summaries: Readonly<Record<DocumentKind, string>>;
};

/**
 * Documents beyond the three primaries that still feed the reconstruction.
 *
 * Extra section sheets add profiles — the single most useful thing a project can
 * supply, because every additional perimeter section replaces a stretch of
 * interpolation with measurement. Extra surveys add soundings.
 */
export type AdditionalDocuments = {
	readonly sections?: readonly RawDocument[];
	readonly bathymetry?: readonly RawDocument[];
};

/** Merge extra section documents, keeping ids unique. */
function mergeSections(
	primary: SectionExtraction,
	extras: readonly SectionExtraction[]
): SectionExtraction {
	if (extras.length === 0) return primary;
	const profiles: Record<string, ProfilePoint[]> = { ...primary.profiles };
	const annotations = [...primary.annotations];
	for (const [index, extra] of extras.entries()) {
		for (const [id, points] of Object.entries(extra.profiles)) {
			const key = profiles[id] ? `${id}#${index + 2}` : id;
			profiles[key] = points;
		}
		annotations.push(...extra.annotations);
	}
	return {
		profiles,
		annotations,
		format: primary.format,
		summary: `${Object.keys(profiles).length} section profile(s) across ${extras.length + 1} document(s)`
	};
}

/**
 * Read the three documents into one `SiteData` in a single metric frame.
 *
 * Nothing here checks that the three documents *are* in the same frame — a plan
 * in survey coordinates and soundings in a local grid will stitch into a solid
 * that looks plausible and is wrong. The overlap check in `stitch.ts` is what
 * catches that.
 */
export function extractSiteData(
	documents: Readonly<Record<DocumentKind, RawDocument>>,
	overrides: StitchOverrides,
	maxCells: number,
	ledger: Ledger,
	additional: AdditionalDocuments = {}
): ExtractionResult {
	const sections = mergeSections(
		extractSections(documents.cross_section, ledger),
		(additional.sections ?? []).map((document) => extractSections(document, ledger))
	);
	const classification = classifyProfiles(sections.profiles, overrides.profileLayers);
	const params = deriveParameters(sections, classification, overrides, ledger);
	const plan = extractPlan(
		documents.floor_plan,
		overrides,
		params,
		sections.profiles,
		classification,
		ledger
	);
	const seabed = extractSeabed(
		[documents.bathymetry, ...(additional.bathymetry ?? [])],
		params.levelsM.toe,
		maxCells,
		ledger
	);

	const shorelineLengthM = overrides.shorelineLengthM ?? plan.plan.shorelineLengthM;
	const resolvedPlan: PlanGeometry = { ...plan.plan, shorelineLengthM };

	const planBounds = boundingBox(resolvedPlan.worksOutline);
	const gridMaxX = seabed.grid.x0 + seabed.grid.dx * (seabed.grid.nx - 1);
	const gridMaxY = seabed.grid.y0 + seabed.grid.dy * (seabed.grid.ny - 1);
	const overlapX = Math.min(planBounds.maxX, gridMaxX) - Math.max(planBounds.minX, seabed.grid.x0);
	const overlapY = Math.min(planBounds.maxY, gridMaxY) - Math.max(planBounds.minY, seabed.grid.y0);
	const planWidth = Math.max(1e-6, planBounds.maxX - planBounds.minX);
	const planHeight = Math.max(1e-6, planBounds.maxY - planBounds.minY);
	const coverage = Math.max(0, Math.min(1, (overlapX / planWidth) * (overlapY / planHeight)));
	if (coverage < 0.6) {
		ledger.require({
			id: 'survey-coverage',
			document: 'bathymetry',
			missing: `soundings cover only about ${(coverage * 100).toFixed(0)}% of the works outline`,
			fix: 'Supply a survey spanning the whole footprint, in the same coordinate frame and on the same datum as the plan. Fill depth is the difference between two elevations on that datum, so an unsurveyed area cannot be measured — only guessed.'
		});
	}
	if (coverage < 0.98) {
		ledger.warn(
			'frame-coverage',
			`The bathymetric survey covers about ${(coverage * 100).toFixed(0)}% of the plan footprint. ` +
				'Either the survey does not reach under the whole works, or the two documents are not in the same coordinate frame — outside the survey the bed is clamped to its edge value.',
			coverage < 0.5 ? 'error' : 'warning'
		);
	}

	// Every seaward edge has to lie on the works outline; an edge drawn away from
	// it puts station 0 in the wrong place and shifts the whole face.
	const outlineRing = [...resolvedPlan.worksOutline, resolvedPlan.worksOutline[0]];
	let strayEdges = 0;
	for (const edge of resolvedPlan.seawardEdges) {
		for (const [x, y] of edge) {
			if (distanceToPolyline(x, y, outlineRing) > 1) strayEdges += 1;
		}
	}
	if (strayEdges > 0) {
		ledger.warn(
			'seaward-edge-off-outline',
			`${strayEdges} seaward-edge vertex/vertices lie more than 1 m off the works outline. Station 0 is measured from those edges, so the face is built from the wrong line.`
		);
	}

	return {
		data: { params, plan: resolvedPlan, profiles: sections.profiles, seabed: seabed.grid },
		classification,
		formats: {
			cross_section: sections.format,
			floor_plan: plan.format,
			bathymetry: seabed.format
		},
		summaries: {
			cross_section: sections.summary,
			floor_plan: plan.summary,
			bathymetry: seabed.summary
		}
	};
}
