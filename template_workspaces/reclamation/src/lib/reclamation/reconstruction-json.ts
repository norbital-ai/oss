/**
 * Validated readers for the JSON columns on `site_reconstructions`.
 *
 * `model_json`, `report_json`, `metrics_json`, and `quantities_json` are written by the stitch
 * engine and read back by the server pricing hook, the project surface, and the revision surface.
 * A cast would only *assert* that a stored blob still matches the engine that reads it, and the
 * three readers disagreed about what a bad blob meant. They do not any more:
 *
 * - a run that failed stores `report_json` holding nothing but the input fingerprint, so a cast
 *   handed the revision surface a `StitchReport` with no `warnings` array and `warnings.length`
 *   threw while rendering;
 * - a blob written by an older engine version parses into a shape the viewer and the volume
 *   integrator index into, and the first missing array surfaces far from the row that lacks it.
 *
 * Validation turns both into one honest answer: `null`, which every call site already renders as
 * "nothing built yet", and which the pricing hook refuses rather than pricing around.
 */

import { z } from 'zod';
import type {
	ReconstructionMetrics,
	StitchReport,
	StitchedModel,
	SubstrateQuantity
} from './types.js';

const point2 = z.tuple([z.number(), z.number()]);
const polygon = z.array(point2);
const slopeRatio = z.object({ v: z.number(), h: z.number() });
const surfaceRole = z.enum(['surface', 'internal']);
const documentKind = z.enum(['floor_plan', 'bathymetry', 'cross_section']);

const sectionParameters = z.object({
	levelsM: z.object({
		toe: z.number(),
		platform: z.number(),
		hwm: z.number().optional(),
		sea: z.number(),
		interim: z.number().optional()
	}),
	slopes: z.record(z.string(), slopeRatio),
	dimensionsM: z.object({
		crestWidth: z.number().optional(),
		armorCrest: z.number().optional(),
		armorThickness: z.number(),
		dredgedRockThickness: z.number().optional(),
		sandKeyWidth: z.number().optional(),
		sandKeyDepth: z.number().optional(),
		caissonWidth: z.number().optional()
	}),
	seawardFaceKind: z.enum(['revetment', 'caisson']),
	materials: z.array(z.string()).optional()
});

const planGeometry = z.object({
	shorelineLengthM: z.number(),
	worksOutline: polygon,
	seawardEdges: z.array(polygon),
	platformTopPolygon: polygon,
	crestPolygon: polygon.optional(),
	armorPolygon: polygon.optional(),
	lagoonPolygons: z.array(polygon).optional(),
	contextPolygons: z.array(z.object({ label: z.string(), polygon })).optional(),
	existingShoreline: polygon.optional(),
	existingLandPolygon: polygon.optional(),
	existingLandLevelM: z.number().optional(),
	structures: z.array(
		z.object({
			id: z.string(),
			category: z.enum(['pre_existing', 'new_works']),
			parts: z.array(
				z.object({
					id: z.string(),
					polygon,
					crestZM: z.number(),
					faceSlopeKey: z.string(),
					faceSlopeKeySeaward: z.string().optional()
				})
			)
		})
	),
	sectionCuts: z.array(
		z.object({
			id: z.string(),
			profileId: z.string(),
			line: polygon,
			type: z.string().optional(),
			chainageM: z.number()
		})
	)
});

/**
 * The survey height field.
 *
 * The row-major length is checked, not assumed: every sampler indexes `z[iy * nx + ix]`, so a
 * truncated grid does not fail — it reads `undefined` as a depth and quietly moves the seabed.
 */
const seabedGrid = z
	.object({
		x0: z.number(),
		y0: z.number(),
		dx: z.number(),
		dy: z.number(),
		nx: z.number().int().nonnegative(),
		ny: z.number().int().nonnegative(),
		z: z.array(z.number())
	})
	.refine((grid) => grid.z.length === grid.nx * grid.ny, {
		message: 'Seabed grid must hold exactly nx * ny samples.'
	});

const profilePoints = z.array(
	z.object({
		stationM: z.number(),
		zCdM: z.number(),
		layer: z.string(),
		segmentId: z.string().optional()
	})
);

const stitchedModel = z.object({
	datum: z.string(),
	params: sectionParameters,
	plan: planGeometry,
	profiles: z.record(z.string(), profilePoints),
	seabed: seabedGrid,
	settings: z.object({
		integrationCellM: z.number(),
		renderCellM: z.number(),
		interpolation: z.enum(['morph', 'prismatic']),
		maxCells: z.number(),
		maxSeabedVertices: z.number().optional()
	}),
	classification: z.object({
		perimeterIds: z.array(z.string()),
		explicit: z.boolean(),
		layers: z.array(z.object({ layer: z.string(), role: surfaceRole })),
		layerOverrides: z
			.object({
				surface: z.array(z.string()).optional(),
				internal: z.array(z.string()).optional(),
				toe: z.array(z.string()).optional()
			})
			.optional()
	}),
	bounds: z.object({
		minX: z.number(),
		maxX: z.number(),
		minY: z.number(),
		maxY: z.number(),
		minZ: z.number(),
		maxZ: z.number()
	})
});

const stitchReport = z.object({
	assumptions: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			detail: z.string(),
			effect: z.string(),
			source: z.enum(['floor_plan', 'bathymetry', 'cross_section', 'default', 'override'])
		})
	),
	layerClassification: z.array(z.object({ layer: z.string(), role: surfaceRole })).optional(),
	warnings: z.array(
		z.object({
			code: z.string(),
			message: z.string(),
			severity: z.enum(['info', 'warning', 'error'])
		})
	),
	documents: z.array(
		z.object({
			kind: documentKind,
			assetId: z.string().nullable(),
			fileName: z.string().nullable(),
			format: z.enum(['dwg', 'dxf', 'pdf', 'xyz', 'csv', 'json', 'unsupported']),
			byteSize: z.number(),
			sha256: z.string(),
			summary: z.string()
		})
	),
	engineVersion: z.string()
});

const reconstructionMetrics = z.object({
	platformAreaM2: z.number(),
	worksFootprintM2: z.number(),
	armorFaceAreaM2: z.number(),
	shorelineLengthM: z.number(),
	meanFillDepthM: z.number(),
	maxFillDepthM: z.number(),
	integratedCells: z.number(),
	integrationCellM: z.number(),
	structureDisplacementM3: z.number(),
	excavationM3: z.number(),
	trenchExcavationM3: z.number(),
	placedVolumeM3: z.number()
});

const substrateQuantities = z.array(
	z.object({
		substrate: z.enum([
			'rock_armor',
			'geofabric',
			'dredged_rock',
			'sand_key',
			'sand_fill',
			'dredged_fill',
			'pvd'
		]),
		unit: z.enum(['m3', 'm2', 'm']),
		quantity: z.number(),
		basis: z.string(),
		method: z.enum(['integrated', 'analytic'])
	})
);

/** Decode one stored blob, returning `null` for absent, malformed, or off-contract JSON. */
function read<S extends z.ZodType>(schema: S, json: string | null | undefined): z.infer<S> | null {
	if (typeof json !== 'string' || json.trim() === '') return null;
	try {
		const result = schema.safeParse(JSON.parse(json));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export function parseStitchedModel(json: string | null | undefined): StitchedModel | null {
	return read(stitchedModel, json);
}

export function parseStitchReport(json: string | null | undefined): StitchReport | null {
	return read(stitchReport, json);
}

export function parseReconstructionMetrics(
	json: string | null | undefined
): ReconstructionMetrics | null {
	return read(reconstructionMetrics, json);
}

export function parseSubstrateQuantities(
	json: string | null | undefined
): SubstrateQuantity[] | null {
	return read(substrateQuantities, json);
}
