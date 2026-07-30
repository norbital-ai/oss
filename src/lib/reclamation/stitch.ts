/**
 * The stitcher: three documents in, one solid out.
 *
 * `stitch()` is the whole reconstruction pipeline and is called from
 * `src/collections/reclamation_projects/+hooks.ts`. It is deliberately pure —
 * bytes in, JSON out — so the same run can be reproduced from the persisted
 * inputs, and so the browser can rebuild the identical surfaces from the
 * persisted model without re-reading the documents.
 */

import { boundingBox, formatSlopeRatio, round } from './math.js';
import {
	extractSiteData,
	Ledger,
	type CalibrationRequirement,
	type RawDocument,
	type StitchOverrides
} from './extract.js';
import { ENGINE_VERSION, integrateSite } from './solids.js';
import { buildPerimeterField, buildPerimeterIndex } from './surface.js';
import type {
	DocumentKind,
	DocumentProvenance,
	SeabedGrid,
	StitchResult,
	StitchSettings,
	StitchedModel
} from './types.js';

/**
 * Defaults tuned for accuracy first.
 *
 * The integration cell governs how exactly the fill is measured; the adaptive
 * refinement at zone boundaries means a 2.5 m cell already resolves an armour
 * band a few metres wide. The render cell governs only how finely the same
 * surface is drawn.
 */
export const DEFAULT_STITCH_SETTINGS: StitchSettings = {
	integrationCellM: 2.5,
	renderCellM: 3,
	interpolation: 'morph',
	maxCells: 1_500_000,
	maxSeabedVertices: 600_000
};

export type StitchInput = {
	readonly documents: Readonly<Record<DocumentKind, RawDocument>>;
	/** Extra section sheets and surveys that also feed the reconstruction. */
	readonly additional?: import('./extract.js').AdditionalDocuments;
	readonly overrides?: StitchOverrides;
	readonly settings?: Partial<StitchSettings>;
};

function compactGrid(grid: SeabedGrid): SeabedGrid {
	return {
		x0: round(grid.x0, 3),
		y0: round(grid.y0, 3),
		dx: round(grid.dx, 4),
		dy: round(grid.dy, 4),
		nx: grid.nx,
		ny: grid.ny,
		z: grid.z.map((value) => round(value, 3))
	};
}

/**
 * Run the reconstruction.
 *
 * Throws when a document cannot be read at all. Anything that is merely
 * uncertain lands in `report.assumptions` or `report.warnings` and the model is
 * still produced, because an engineer needs to see the shape before deciding
 * whether the uncertainty matters.
 */
export function stitch(input: StitchInput): StitchResult {
	const settings: StitchSettings = { ...DEFAULT_STITCH_SETTINGS, ...input.settings };
	const overrides = input.overrides ?? {};
	const ledger = new Ledger();

	const extraction = extractSiteData(
		input.documents,
		overrides,
		settings.maxCells,
		ledger,
		input.additional
	);

	// Calibration gate. Everything above this line is best effort; below it the
	// engine has to place the works in space, and a missing reference there
	// cannot be assumed around — it would produce a solid that looks right and
	// measures wrong. All shortfalls are reported at once so one pass fixes them.
	if (ledger.required.length > 0) {
		throw new Error(formatCalibrationFailure(ledger.required));
	}

	const { params, plan, profiles, seabed } = extraction.data;

	const planBounds = boundingBox([
		...plan.worksOutline,
		...plan.seawardEdges.flat(),
		...(plan.existingLandPolygon ?? []),
		...(plan.contextPolygons ?? []).flatMap((entry) => entry.polygon),
		...plan.structures.flatMap((structure) => structure.parts.flatMap((part) => part.polygon))
	]);
	let minZ = Number.POSITIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const value of seabed.z) {
		if (value < minZ) minZ = value;
		if (value > maxZ) maxZ = value;
	}
	minZ = Math.min(minZ, params.levelsM.toe);
	maxZ = Math.max(maxZ, params.levelsM.platform);

	const model: StitchedModel = {
		datum: overrides.datum ?? 'CD',
		params,
		plan,
		profiles,
		seabed: compactGrid(seabed),
		settings,
		classification: {
			perimeterIds: extraction.classification.perimeterIds,
			explicit: extraction.classification.explicit,
			layers: extraction.classification.layers,
			...(overrides.profileLayers ? { layerOverrides: overrides.profileLayers } : {})
		},
		bounds: {
			minX: planBounds.minX,
			maxX: planBounds.maxX,
			minY: Math.min(planBounds.minY, seabed.y0),
			maxY: Math.max(planBounds.maxY, seabed.y0 + seabed.dy * (seabed.ny - 1)),
			minZ,
			maxZ
		}
	};

	recordStandingAssumptions(model, ledger);

	const { quantities, metrics } = integrateSite(model);

	const filled = metrics.placedVolumeM3;
	if (metrics.excavationM3 > Math.max(1000, filled * 0.01)) {
		ledger.warn(
			'design-below-bed',
			`${Math.round(metrics.excavationM3).toLocaleString()} m³ of the footprint sits below the surveyed bed, so that part of the works is a cut rather than a fill. ` +
				'That is real dredging where the design toe is deeper than the seabed, and a coordinate-frame or datum mismatch otherwise. ' +
				'The volume is measured but deliberately not priced here: dredging and disposal are a manual take-off, because the rate depends on the material and the disposal ground rather than on the shape.'
		);
		ledger.assume({
			id: 'cut-not-filled',
			title: 'Columns below the surveyed bed are reported, not filled',
			detail:
				'Where the design surface is lower than the existing surface the engine records excavation and places no fill, so the solid stops at the bed instead of hanging under it.',
			effect:
				'The armour blanket thins or disappears wherever the surveyed bed already stands above the drawn toe level, which lowers the armour and geofabric quantities against a hand take-off done from the section alone.',
			source: 'default'
		});
	}

	const primary: DocumentProvenance[] = (
		['floor_plan', 'bathymetry', 'cross_section'] as const
	).map((kind) => ({
		kind,
		assetId: input.documents[kind].assetId,
		fileName: input.documents[kind].fileName,
		format: extraction.formats[kind],
		byteSize: input.documents[kind].bytes.byteLength,
		sha256: input.documents[kind].sha256,
		summary: extraction.summaries[kind]
	}));
	const extras: DocumentProvenance[] = [
		...(input.additional?.sections ?? []),
		...(input.additional?.bathymetry ?? [])
	].map((document: RawDocument) => ({
		kind: document.kind,
		assetId: document.assetId,
		fileName: document.fileName,
		format: extraction.formats[document.kind],
		byteSize: document.bytes.byteLength,
		sha256: document.sha256,
		summary: 'additional reconstruction input'
	}));
	const documents = [...primary, ...extras];

	return {
		model,
		quantities: quantities.map((entry) => ({ ...entry, quantity: round(entry.quantity, 2) })),
		metrics: {
			...metrics,
			platformAreaM2: round(metrics.platformAreaM2, 1),
			worksFootprintM2: round(metrics.worksFootprintM2, 1),
			armorFaceAreaM2: round(metrics.armorFaceAreaM2, 1),
			meanFillDepthM: round(metrics.meanFillDepthM, 3),
			maxFillDepthM: round(metrics.maxFillDepthM, 3),
			structureDisplacementM3: round(metrics.structureDisplacementM3, 1),
			excavationM3: round(metrics.excavationM3, 1),
			placedVolumeM3: round(metrics.placedVolumeM3, 1)
		},
		report: {
			assumptions: ledger.assumptions,
			warnings: ledger.warnings,
			layerClassification: extraction.classification.layers,
			documents,
			engineVersion: ENGINE_VERSION
		}
	};
}

/** One actionable message listing every calibration point the drawings lack. */
function formatCalibrationFailure(required: readonly CalibrationRequirement[]): string {
	const byDocument = new Map<string, CalibrationRequirement[]>();
	for (const entry of required) {
		byDocument.set(entry.document, [...(byDocument.get(entry.document) ?? []), entry]);
	}
	const sections = [...byDocument.entries()].map(([document, entries]) => {
		const label = document.replace('_', ' ');
		const lines = entries.map((entry) => `  - ${entry.missing}\n    ${entry.fix}`);
		return `${label}:\n${lines.join('\n')}`;
	});
	return (
		`The shape of the site cannot be deduced from these documents: ${required.length} calibration ` +
		`point(s) are missing.\n\n${sections.join('\n\n')}\n\n` +
		'Add the references above and re-run, or set the equivalent value in the project ' +
		'stitch overrides. Nothing was assumed in their place.'
	);
}

/**
 * Assumptions that are true of every run, recorded whether or not anything went
 * wrong. These are the statements that decide whether the solid resembles the
 * as-built works, so they are never hidden behind a happy path.
 */
function recordStandingAssumptions(model: StitchedModel, ledger: Ledger): void {
	const index = buildPerimeterIndex(model.plan.seawardEdges);
	const field = buildPerimeterField(
		model.profiles,
		model.plan,
		index,
		model.settings.interpolation,
		model.classification
	);
	const sectionCount = field.entries.length;
	const seaward = model.params.slopes.seaward;

	ledger.assume({
		id: 'single-metric-frame',
		title: 'The three documents share one metric frame',
		detail:
			'Plan XY, section stations, and survey XY are read as metres in the same local frame, with Y increasing seaward and station 0 at the toe. No coordinate transform, unit conversion, or georeferencing is applied.',
		effect:
			'If the plan is in survey grid coordinates and the survey is in a local grid, the solid still builds and looks reasonable while sitting over the wrong bed. Check the coverage warning and the fill depths first.',
		source: 'default'
	});

	if (sectionCount <= 1) {
		ledger.assume({
			id: 'prismatic-single-section',
			title: 'One perimeter section governs the whole shoreline',
			detail: `Only one section reaches the toe, so its shape wraps the full ${model.plan.shorelineLengthM.toFixed(0)} m of seaward perimeter.`,
			effect:
				'Every alongshore change in the real works — a deeper toe, a wider crest, a different batter — is absent. Add a section at each chainage where the typical detail changes.',
			source: 'cross_section'
		});
	} else if (model.settings.interpolation === 'morph') {
		ledger.assume({
			id: 'linear-morph-between-sections',
			title: `Geometry changes linearly between the ${sectionCount} perimeter sections`,
			detail:
				'Between two cuts the engine interpolates elevation at every station, and interpolates the armour and crest limits, linearly with chainage.',
			effect:
				'A face that in reality turns, steps, or changes batter part-way between two sheets is drawn as a straight ruled sweep between them. The error is largest midway between cuts and zero at each cut.',
			source: 'default'
		});
	} else {
		ledger.assume({
			id: 'prismatic-between-sections',
			title: `The works are prismatic between the ${sectionCount} perimeter sections`,
			detail:
				'Each chainage snaps to its nearest section, so the solid is constant between cuts and steps at the midpoint between them.',
			effect:
				'Alongshore transitions appear as a discontinuity rather than a sweep. Switch the project to `morph` interpolation for a continuous surface.',
			source: 'default'
		});
	}

	ledger.assume({
		id: 'constant-seaward-batter',
		title: `The seaward face holds ${formatSlopeRatio(seaward)} at every chainage`,
		detail:
			'The face batter is read from the section polyline segment leaving the toe and is applied to the whole shore-normal profile at every chainage, straight from the toe line up to the crest. Local flattening, berms outside the drawn detail, and construction tolerance are not modelled.',
		effect:
			'Armour volume, geofabric area, and the toe position all move with this batter: a face 10% flatter than drawn adds roughly 10% to the armour face area and pushes the toe further seaward than the plan shows.',
		source: 'cross_section'
	});

	ledger.assume({
		id: 'station-is-distance-to-perimeter',
		title: 'Station is the shortest distance to the nearest seaward edge',
		detail:
			'Station 0 sits on the plan perimeter and increases inward, measured normal to whichever quay or revetment edge is closest. A curved shoreline, a stepped toe, and a finger pier with water on three sides are all handled by the same rule.',
		effect:
			'At a re-entrant corner two faces claim the same ground and the nearer one wins, so the fillet a real design would carry around the corner is drawn as a sharp mitre. Where the plan perimeter and the section run (rise × h/v) disagree, the plan fixes the toe position and the section fixes the shape, so the crest can land a few metres from where the plan draws it.',
		source: 'floor_plan'
	});

	ledger.assume({
		id: 'platform-level-to-plan-limit',
		title: 'The platform runs level from the last section station inward',
		detail:
			'A section sheet stops at its drawing edge. Beyond the last station the finished level is held constant across the rest of the works outline.',
		effect:
			'Any landward grading, drainage fall, or terracing beyond the drawn section is missing, which understates or overstates fill on the inland part of the pad.',
		source: 'default'
	});

	ledger.assume({
		id: 'bund-priced-as-sand',
		title: 'The perimeter bund is priced as sand fill through its full height',
		detail: `Columns in the armour and crest zones are taken as bund sand, while platform columns split at ${(model.params.levelsM.interim ?? 0).toFixed(2)} m into dredged material below and sand above.`,
		effect:
			'Moving that boundary shifts volume between the sand and dredged rates without changing the total solid.',
		source: 'cross_section'
	});

	if (model.plan.structures.length > 0) {
		ledger.assume({
			id: 'structure-linear-apron',
			title: 'Pre-existing embankments fall away on one straight batter',
			detail:
				'Each structure is modelled as its plan footprint at crest level with a single straight face running down to the surveyed bed on all sides. New fill is measured from whichever is higher, the bed or the structure.',
			effect:
				'A real bund with a berm, a rock toe, or different batters on its two faces displaces a different amount of new fill than this apron does.',
			source: 'default'
		});
	}

	if (model.params.seawardFaceKind === 'caisson') {
		ledger.assume({
			id: 'caisson-as-vertical-face',
			title: 'The quay wall is modelled as a vertical earth-retaining face',
			detail:
				'The caisson itself is not meshed as a concrete unit: the model carries the retained fill up to the quay level at the toe line.',
			effect:
				'Concrete volume, the founding trench, and any rock bedding under the caissons are outside the model and outside the estimate.',
			source: 'cross_section'
		});
	}
}
