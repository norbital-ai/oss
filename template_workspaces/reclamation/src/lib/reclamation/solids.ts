/**
 * The stitched solid: volume integration and surface tessellation.
 *
 * Both entry points walk the *same* samplers over a regular plan grid, so the
 * quantity in the estimate is the volume of the shape on screen — integrated as
 * ∫(z_design − z_bed) dA over the survey, not as a mean-depth prism.
 *
 * Meshes are emitted in the engineering frame (X alongshore, Y shore-normal
 * seaward, Z elevation). The viewer rotates the whole group once, so nothing in
 * this file knows about a rendering library.
 */

import { polygonArea, verticalThicknessOnSlope } from './math.js';
import { createSampler, samplePerimeter, type SiteSampler, type ZoneId } from './surface.js';
import type {
	Point2,
	ReconstructionMetrics,
	SectionCutLine,
	SiteSurfaces,
	StitchedModel,
	SubstrateQuantity,
	SurfaceId,
	SurfaceMesh
} from './types.js';

export const ENGINE_VERSION = '0.0.1';

type Accumulator = {
	rockArmor: number;
	sandFill: number;
	dredgedFill: number;
	armorFaceArea: number;
	worksFootprint: number;
	fillDepthSum: number;
	maxFillDepth: number;
	structureDisplacement: number;
	excavation: number;
	/** Dug to reach a trench invert the section draws — specified, not a surprise. */
	trenchExcavation: number;
	/** Volume per substrate coming from below-grade bands read off the section. */
	subGrade: Map<string, number>;
	/** Total material placed — the sum the substrate lines must reconstruct. */
	placed: number;
	cells: number;
};

function resolveCell(
	model: StitchedModel,
	requested: number,
	spanX: number,
	spanY: number
): number {
	const cells = (spanX / requested) * (spanY / requested);
	if (cells <= model.settings.maxCells) return requested;
	return requested * Math.sqrt(cells / model.settings.maxCells);
}

/**
 * Integrate the stitched solid over the plan.
 *
 * Every column runs from the *existing* surface — the surveyed bed, or the crest
 * of a pre-existing structure where one stands proud of it — up to the finished
 * design surface. Rock armour takes the outer skin of the seaward face; the
 * remainder is fill, split by material level on the platform and taken as bund
 * sand on the perimeter.
 */
export function integrateSite(model: StitchedModel): {
	quantities: SubstrateQuantity[];
	metrics: ReconstructionMetrics;
} {
	const sampler = createSampler(model);
	const spanX = Math.max(1, sampler.maxX - sampler.minX);
	const spanY = Math.max(1, sampler.maxY - sampler.minY);
	const cell = resolveCell(model, model.settings.integrationCellM, spanX, spanY);
	const cellArea = cell * cell;

	const armorThickness =
		model.params.seawardFaceKind === 'revetment' ? model.params.dimensionsM.armorThickness : 0;
	const materialLevel = model.params.levelsM.interim ?? 0;

	/**
	 * Local steepening factor of the design surface, `sqrt(1 + (dz/ds)²)`.
	 *
	 * Station is a distance function, so the surface gradient is the profile
	 * gradient at that station: two extra profile samples give it exactly. Using
	 * the local value rather than one global batter makes the armour volume and
	 * the geofabric area come out as `thickness × true surface area` and
	 * `true surface area` for *any* section shape — including a face that
	 * changes slope, or flattens onto a Detail-A crest.
	 */
	const DELTA = 0.25;
	const surfaceFactorAt = (sample: { arcM: number; stationM: number }): number => {
		const back = samplePerimeter(sampler.field, sample.arcM, Math.max(0, sample.stationM - DELTA));
		const forward = samplePerimeter(sampler.field, sample.arcM, sample.stationM + DELTA);
		if (!back || !forward) return 1;
		const span = sample.stationM + DELTA - Math.max(0, sample.stationM - DELTA);
		if (span <= 1e-9) return 1;
		const gradient = (forward.z - back.z) / span;
		return Math.hypot(1, gradient);
	};

	const totals: Accumulator = {
		rockArmor: 0,
		sandFill: 0,
		dredgedFill: 0,
		armorFaceArea: 0,
		worksFootprint: 0,
		fillDepthSum: 0,
		maxFillDepth: 0,
		structureDisplacement: 0,
		excavation: 0,
		trenchExcavation: 0,
		subGrade: new Map<string, number>(),
		placed: 0,
		cells: 0
	};

	/**
	 * Accumulate one column of plan area `area` at `(x, y)`.
	 *
	 * Split out so a cell straddling a zone boundary can be re-integrated on a
	 * finer sub-grid: the armour band is only a handful of cells wide, so a
	 * boundary quantised to whole cells moves the armour volume by several
	 * percent depending on how the grid happens to fall across it.
	 */
	const accumulate = (x: number, y: number, area: number): void => {
		{
			const works = sampler.worksAt(x, y);
			if (!works) return;
			const cellArea = area;
			totals.worksFootprint += cellArea;

			const bed = sampler.bedAt(x, y);
			const structureTop = sampler.structureAt?.(x, y, bed);
			const base = structureTop !== undefined && structureTop > bed ? structureTop : bed;
			if (structureTop !== undefined && structureTop > bed) {
				totals.structureDisplacement += (Math.min(structureTop, works.z) - bed) * cellArea;
			}

			const height = works.z - base;
			if (height <= 0) {
				// The design surface lies below the existing one: this column is cut,
				// not filled. Reported as a metric rather than priced, because no
				// dredging rate is part of the substrate matrix.
				totals.excavation += -height * cellArea;
				return;
			}
			totals.fillDepthSum += height * cellArea;
			if (height > totals.maxFillDepth) totals.maxFillDepth = height;
			// `placed` accumulates the material actually placed, which is what the
			// substrate lines must sum to. It differs from the design-minus-bed
			// prism only where the armour blanket reaches below the bed.

			let remaining = height;
			if (works.zone === 'armor' && armorThickness > 0) {
				// The blanket keeps its full specified thickness, measured
				// perpendicular to the face. It is not thinned to fit the fill
				// available beneath it: an armour layer is placed on the bed, and
				// thinning it here would make the armour volume and the geofabric
				// area describe different extents of the same band. Where the
				// blanket reaches below the existing bed, that part is reported as
				// excavation rather than quietly dropped.
				const factor = surfaceFactorAt(works);
				const armorColumn = armorThickness * factor;
				totals.rockArmor += armorColumn * cellArea;
				totals.armorFaceArea += cellArea * factor;
				const belowBed = Math.max(0, armorColumn - height);
				if (belowBed > 0) totals.excavation += belowBed * cellArea;
				totals.placed += armorColumn * cellArea;
				remaining -= armorColumn;
			}
			if (remaining <= 0) return;
			totals.placed += remaining * cellArea;

			if (works.zone === 'platform') {
				const top = works.z - (height - remaining);
				const above = Math.max(0, top - Math.max(base, materialLevel));
				totals.sandFill += above * cellArea;
				totals.dredgedFill += (remaining - above) * cellArea;
			} else {
				totals.sandFill += remaining * cellArea;
			}
		}
	};

	/**
	 * Below-grade bands at one column.
	 *
	 * The section gives each band's invert on the project datum; the survey gives
	 * the bed on the same datum. The band is therefore dug by comparing two
	 * elevations, never by assuming a depth: excavation is what is removed to
	 * reach the invert, and the same volume is the substrate placed back into it.
	 * Geofabric is excluded — it is a sheet, measured with the armour face.
	 */
	const accumulateBands = (x: number, y: number, area: number): void => {
		const bands = sampler.subGradeAt(x, y);
		if (bands.length === 0) return;
		const bed = sampler.bedAt(x, y);
		const works = sampler.worksAt(x, y);
		// Dug from whichever surface is lower: the existing bed, or the design
		// surface where the works have already cut down to it.
		const ceiling = works ? Math.min(bed, works.z) : bed;
		for (const band of bands) {
			if (band.substrate === 'geofabric') continue;
			// A band the section drew a top for is bounded by that top: a 1 m rock
			// blanket stays 1 m thick over a bed standing well above its invert,
			// instead of being read as a trench dug down from that bed.
			const roof = band.topM === undefined ? ceiling : Math.min(ceiling, band.topM);
			const depth = roof - band.invertM;
			if (depth <= 0) continue;
			totals.subGrade.set(
				band.substrate,
				(totals.subGrade.get(band.substrate) ?? 0) + depth * area
			);
			totals.trenchExcavation += depth * area;
			totals.placed += depth * area;
		}
	};

	/** A cell within one cell width of a zone limit is re-integrated finer. */
	const REFINE = 4;
	const subArea = cellArea / (REFINE * REFINE);

	// The grid reaches beyond the works outline by the furthest seaward extent of
	// any below-grade band, so a sand key trench outside the toe is integrated
	// rather than estimated.
	const reach = Math.ceil(sampler.seawardReachM / cell + 1) * cell;
	for (let x = sampler.minX - reach + cell / 2; x <= sampler.maxX + reach; x += cell) {
		for (let y = sampler.minY - reach + cell / 2; y <= sampler.maxY + reach; y += cell) {
			accumulateBands(x, y, cellArea);
			const probe = sampler.worksAt(x, y);
			if (!probe) continue;
			totals.cells += 1;
			const nearLimit =
				Math.abs(probe.stationM - probe.armorEndStation) < cell ||
				Math.abs(probe.stationM - probe.crestEndStation) < cell ||
				probe.stationM < cell;
			if (!nearLimit) {
				accumulate(x, y, cellArea);
				continue;
			}
			for (let sy = 0; sy < REFINE; sy++) {
				for (let sx = 0; sx < REFINE; sx++) {
					accumulate(
						x - cell / 2 + ((sx + 0.5) * cell) / REFINE,
						y - cell / 2 + ((sy + 0.5) * cell) / REFINE,
						subArea
					);
				}
			}
		}
	}

	if (totals.cells === 0) {
		throw new Error(
			'The works footprint integrated to zero cells. Check that the works outline on the floor plan ' +
				'encloses an area and that it is in the same coordinate frame as the survey.'
		);
	}

	const shoreline = model.plan.shorelineLengthM;
	const sandKeyWidth = model.params.dimensionsM.sandKeyWidth ?? 0;
	const sandKeyDepth = model.params.dimensionsM.sandKeyDepth ?? 0;
	const dredgedRockThickness = model.params.dimensionsM.dredgedRockThickness ?? 0;

	/**
	 * A below-grade substrate: integrated against the bed where the section drew
	 * an invert for it, and a prism from the stated dimensions only where it did
	 * not. The two are never added together.
	 */
	const belowGrade = (
		substrate: SubstrateQuantity['substrate'],
		prism: number,
		prismBasis: string
	): SubstrateQuantity => {
		const dug = totals.subGrade.get(substrate);
		if (dug !== undefined && dug > 0) {
			return {
				substrate,
				unit: 'm3',
				quantity: dug,
				method: 'integrated',
				basis: `dug from the surveyed bed down to the invert drawn on the section, at a ${cell.toFixed(1)} m cell`
			};
		}
		return { substrate, unit: 'm3', quantity: prism, method: 'analytic', basis: prismBasis };
	};

	const quantities: SubstrateQuantity[] = [
		{
			substrate: 'rock_armor',
			unit: 'm3',
			quantity: totals.rockArmor,
			method: 'integrated',
			basis: `${armorThickness.toFixed(2)} m blanket perpendicular to the face over ${Math.round(totals.armorFaceArea).toLocaleString()} m² of sloped face, integrated at a ${cell.toFixed(1)} m cell`
		},
		{
			substrate: 'geofabric',
			unit: 'm2',
			quantity: totals.armorFaceArea,
			method: 'integrated',
			basis: 'one layer under the armour, 1:1 with the true sloped face area'
		},
		{
			substrate: 'sand_fill',
			unit: 'm3',
			quantity: totals.sandFill,
			method: 'integrated',
			basis: `perimeter bund plus platform fill above ${materialLevel.toFixed(2)} m, measured from the surveyed bed`
		},
		{
			substrate: 'dredged_fill',
			unit: 'm3',
			quantity: totals.dredgedFill,
			method: 'integrated',
			basis: `platform fill below ${materialLevel.toFixed(2)} m, measured from the surveyed bed`
		},
		belowGrade(
			'sand_key',
			shoreline * sandKeyWidth * sandKeyDepth,
			`${shoreline.toFixed(0)} m perimeter × ${sandKeyWidth.toFixed(1)} m × ${sandKeyDepth.toFixed(1)} m trench (prism — the section drew no invert to dig against)`
		),
		belowGrade(
			'dredged_rock',
			shoreline * sandKeyWidth * dredgedRockThickness,
			`${shoreline.toFixed(0)} m perimeter × ${sandKeyWidth.toFixed(1)} m × ${dredgedRockThickness.toFixed(2)} m foundation rock (prism — the section drew no invert to dig against)`
		)
	];

	const metrics: ReconstructionMetrics = {
		platformAreaM2: polygonArea(model.plan.platformTopPolygon),
		worksFootprintM2: totals.worksFootprint,
		armorFaceAreaM2: totals.armorFaceArea,
		shorelineLengthM: shoreline,
		meanFillDepthM: totals.worksFootprint > 0 ? totals.fillDepthSum / totals.worksFootprint : 0,
		maxFillDepthM: totals.maxFillDepth,
		integratedCells: totals.cells,
		integrationCellM: cell,
		structureDisplacementM3: totals.structureDisplacement,
		excavationM3: totals.excavation,
		trenchExcavationM3: totals.trenchExcavation,
		placedVolumeM3: totals.placed
	};

	return { quantities, metrics };
}

/* --------------------------------------------------------------- meshing */

class MeshBuilder {
	private readonly positions: number[] = [];
	private readonly indices: number[] = [];

	vertex(x: number, y: number, z: number): number {
		this.positions.push(x, y, z);
		return this.positions.length / 3 - 1;
	}

	triangle(a: number, b: number, c: number): void {
		this.indices.push(a, b, c);
	}

	/** Emit one vertex per polygon corner at a constant level; returns their indices. */
	polygonIndices(polygon: readonly Point2[], level: number): number[] {
		return polygon.map((point) => this.vertex(point[0], point[1], level));
	}

	quad(a: number, b: number, c: number, d: number): void {
		this.triangle(a, b, c);
		this.triangle(a, c, d);
	}

	get empty(): boolean {
		return this.indices.length === 0;
	}

	finish(
		id: SurfaceId,
		label: string,
		color: number,
		opacity: number,
		doubleSided: boolean
	): SurfaceMesh {
		const positions = new Float32Array(this.positions);
		const indices = new Uint32Array(this.indices);
		const normals = new Float32Array(positions.length);
		for (let index = 0; index < indices.length; index += 3) {
			const ia = indices[index] * 3;
			const ib = indices[index + 1] * 3;
			const ic = indices[index + 2] * 3;
			const ux = positions[ib] - positions[ia];
			const uy = positions[ib + 1] - positions[ia + 1];
			const uz = positions[ib + 2] - positions[ia + 2];
			const vx = positions[ic] - positions[ia];
			const vy = positions[ic + 1] - positions[ia + 1];
			const vz = positions[ic + 2] - positions[ia + 2];
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			for (const offset of [ia, ib, ic]) {
				normals[offset] += nx;
				normals[offset + 1] += ny;
				normals[offset + 2] += nz;
			}
		}
		for (let index = 0; index < normals.length; index += 3) {
			const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
			if (length > 1e-12) {
				normals[index] /= length;
				normals[index + 1] /= length;
				normals[index + 2] /= length;
			} else {
				normals[index + 2] = 1;
			}
		}
		return { id, label, color, opacity, doubleSided, positions, normals, indices };
	}
}

/**
 * Ear-clipping triangulation for a simple polygon.
 *
 * Flat context surfaces — existing land, containment ponds, adjacent works — are
 * polygons, not height fields. Gridding their bounding box would spend millions
 * of triangles on a flat plane and would spill outside a concave outline; a fan
 * would fold back on itself for the same shape.
 *
 * `earcut` is the natural third-party choice here and this is a drop-in for it:
 * same signature, same output shape. It is in-tree only because this workspace
 * cannot currently resolve new npm dependencies.
 */
function triangulatePolygon(polygon: readonly Point2[]): readonly (readonly number[])[] {
	if (polygon.length < 3) return [];

	const area = (a: Point2, b: Point2, c: Point2): number =>
		(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

	/**
	 * Drop vertices that carry no shape.
	 *
	 * A traced coastline arrives with runs of nearly collinear points. Clipping
	 * an ear off such a run yields a triangle with real length and no height —
	 * one measured at 169,000:1 on the Tuas outline — which shades as a bright
	 * needle and reads as a spike radiating out of the surface. They contribute
	 * nothing to the area either, so the honest move is not to create them.
	 */
	const kept: number[] = [];
	for (let index = 0; index < polygon.length; index++) {
		const previous = polygon[(index + polygon.length - 1) % polygon.length];
		const current = polygon[index];
		const next = polygon[(index + 1) % polygon.length];
		if (current[0] === previous[0] && current[1] === previous[1]) continue;
		const longest = Math.max(
			Math.hypot(current[0] - previous[0], current[1] - previous[1]),
			Math.hypot(next[0] - current[0], next[1] - current[1])
		);
		// Twice the triangle's area over its longest edge is its height. Below a
		// millimetre the corner is a straight line as far as any surface goes.
		const height = Math.abs(area(previous, current, next)) / Math.max(longest, 1e-9);
		if (height < 1e-3) continue;
		kept.push(index);
	}
	if (kept.length < 3) return [];

	const ring = [...kept];
	let signed = 0;
	for (let index = 0; index < ring.length; index++) {
		const [x0, y0] = polygon[ring[index]];
		const [x1, y1] = polygon[ring[(index + 1) % ring.length]];
		signed += x0 * y1 - x1 * y0;
	}
	// Work anticlockwise so a positive cross product means a convex corner.
	if (signed < 0) ring.reverse();

	const inside = (a: Point2, b: Point2, c: Point2, p: Point2): boolean =>
		area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0;

	/** Squared aspect of a candidate ear: lower is a rounder, better triangle. */
	const badness = (a: Point2, b: Point2, c: Point2): number => {
		const doubleArea = Math.abs(area(a, b, c));
		if (doubleArea < 1e-12) return Infinity;
		const longest = Math.max(
			Math.hypot(b[0] - a[0], b[1] - a[1]),
			Math.hypot(c[0] - b[0], c[1] - b[1]),
			Math.hypot(a[0] - c[0], a[1] - c[1])
		);
		return (longest * longest) / doubleArea;
	};

	const triangles: number[][] = [];
	let guard = ring.length * ring.length;
	while (ring.length > 3 && guard-- > 0) {
		// Take the *best* ear available, not the first one found. Clipping the
		// first valid ear walks around the ring shaving slivers off one end;
		// choosing the roundest keeps the whole triangulation well shaped.
		let bestIndex = -1;
		let bestScore = Infinity;
		for (let index = 0; index < ring.length; index++) {
			const ia = ring[(index + ring.length - 1) % ring.length];
			const ib = ring[index];
			const ic = ring[(index + 1) % ring.length];
			const a = polygon[ia];
			const b = polygon[ib];
			const c = polygon[ic];
			if (area(a, b, c) <= 0) continue;
			const contains = ring.some(
				(other) => other !== ia && other !== ib && other !== ic && inside(a, b, c, polygon[other])
			);
			if (contains) continue;
			const score = badness(a, b, c);
			if (score < bestScore) {
				bestScore = score;
				bestIndex = index;
			}
		}
		if (bestIndex < 0) break;
		const ia = ring[(bestIndex + ring.length - 1) % ring.length];
		const ib = ring[bestIndex];
		const ic = ring[(bestIndex + 1) % ring.length];
		triangles.push([ia, ib, ic]);
		ring.splice(bestIndex, 1);
	}
	if (ring.length === 3) triangles.push([ring[0], ring[1], ring[2]]);
	return triangles;
}

/** One flat polygon at a constant level. */
function addFlatPolygon(builder: MeshBuilder, polygon: readonly Point2[], level: number): void {
	const indices = builder.polygonIndices(polygon, level);
	for (const [a, b, c] of triangulatePolygon(polygon)) {
		builder.triangle(indices[a], indices[b], indices[c]);
	}
}

const ZONE_STYLE: Record<ZoneId, { id: SurfaceId; label: string; color: number }> = {
	armor: { id: 'armor', label: 'Rock armour face', color: 0x5c6470 },
	crest: { id: 'crest', label: 'Perimeter bund crest', color: 0xb9a97f },
	platform: { id: 'platform', label: 'Reclaimed platform', color: 0xd8c79a }
};

type Cell = {
	readonly z: number;
	readonly zone: ZoneId;
	readonly bed: number;
	readonly base: number;
	/** Underside of the armour blanket where one exists, else `null`. */
	readonly armorBase: number | null;
};

/**
 * Tessellate every surface in the model.
 *
 * Resolution follows `settings.renderCellM`: the mesh is a regular sampling of
 * the same design surface the integrator uses, so raising the resolution costs
 * triangles but never changes the shape being described.
 */
export function buildSurfaces(model: StitchedModel): SiteSurfaces {
	const sampler = createSampler(model);
	const spanX = Math.max(1, sampler.maxX - sampler.minX);
	const spanY = Math.max(1, sampler.maxY - sampler.minY);
	const cell = resolveCell(model, model.settings.renderCellM, spanX, spanY);

	const columns = Math.max(2, Math.round(spanX / cell) + 1);
	const rows = Math.max(2, Math.round(spanY / cell) + 1);
	const grid: (Cell | null)[] = new Array(columns * rows).fill(null);
	const positionOf = (ix: number, iy: number): { x: number; y: number } => ({
		x: sampler.minX + (ix * spanX) / (columns - 1),
		y: sampler.minY + (iy * spanY) / (rows - 1)
	});

	// The armour blanket is drawn as a real layer of the thickness the section
	// dimensions, measured perpendicular to the face and converted to a vertical
	// offset. What is drawn and what is priced are then the same slab.
	const armorRatio = model.params.slopes.seaward;
	const armorThickness =
		model.params.seawardFaceKind === 'revetment' ? model.params.dimensionsM.armorThickness : 0;
	const armorVertical = verticalThicknessOnSlope(armorThickness, armorRatio);

	for (let iy = 0; iy < rows; iy++) {
		for (let ix = 0; ix < columns; ix++) {
			const { x, y } = positionOf(ix, iy);
			const works = sampler.worksAt(x, y);
			if (!works) continue;
			const bed = sampler.bedAt(x, y);
			const structureTop = sampler.structureAt?.(x, y, bed);
			const base = structureTop !== undefined && structureTop > bed ? structureTop : bed;
			const armorBase =
				works.zone === 'armor' && armorVertical > 0
					? Math.max(base, works.z - armorVertical)
					: null;
			grid[iy * columns + ix] = { z: works.z, zone: works.zone, bed, base, armorBase };
		}
	}

	const zoneBuilders: Record<ZoneId, MeshBuilder> = {
		armor: new MeshBuilder(),
		crest: new MeshBuilder(),
		platform: new MeshBuilder()
	};
	const skirt = new MeshBuilder();

	const vertexCache = new Map<string, number>();
	const zoneVertex = (zone: ZoneId, ix: number, iy: number, cellData: Cell): number => {
		const key = `${zone}:${ix}:${iy}`;
		const cached = vertexCache.get(key);
		if (cached !== undefined) return cached;
		const { x, y } = positionOf(ix, iy);
		const index = zoneBuilders[zone].vertex(x, y, cellData.z);
		vertexCache.set(key, index);
		return index;
	};
	const underVertex = (ix: number, iy: number, cellData: Cell): number => {
		const key = `under:${ix}:${iy}`;
		const cached = vertexCache.get(key);
		if (cached !== undefined) return cached;
		const { x, y } = positionOf(ix, iy);
		const index = zoneBuilders.armor.vertex(x, y, cellData.armorBase ?? cellData.z);
		vertexCache.set(key, index);
		return index;
	};

	for (let iy = 0; iy < rows - 1; iy++) {
		for (let ix = 0; ix < columns - 1; ix++) {
			const a = grid[iy * columns + ix];
			const b = grid[iy * columns + ix + 1];
			const c = grid[(iy + 1) * columns + ix + 1];
			const d = grid[(iy + 1) * columns + ix];
			if (!a || !b || !c || !d) continue;
			const zone = a.zone;
			zoneBuilders[zone].quad(
				zoneVertex(zone, ix, iy, a),
				zoneVertex(zone, ix + 1, iy, b),
				zoneVertex(zone, ix + 1, iy + 1, c),
				zoneVertex(zone, ix, iy + 1, d)
			);
			if (zone !== 'armor' || a.armorBase === null) continue;
			if (b.armorBase === null || c.armorBase === null || d.armorBase === null) continue;
			// Underside of the blanket, wound the other way so it faces down.
			zoneBuilders.armor.quad(
				underVertex(ix, iy, a),
				underVertex(ix, iy + 1, d),
				underVertex(ix + 1, iy + 1, c),
				underVertex(ix + 1, iy, b)
			);
		}
	}

	// Close the blanket wherever it stops: at the landward end of the armour
	// zone, and wherever it runs out against the bed.
	for (let iy = 0; iy < rows - 1; iy++) {
		for (let ix = 0; ix < columns - 1; ix++) {
			const a = grid[iy * columns + ix];
			if (!a || a.armorBase === null) continue;
			const neighbours: (Cell | null)[] = [
				ix + 1 < columns ? grid[iy * columns + ix + 1] : null,
				iy + 1 < rows ? grid[(iy + 1) * columns + ix] : null
			];
			const partners: (Cell | null)[] = [
				ix + 1 < columns ? grid[iy * columns + ix + 1] : null,
				iy + 1 < rows ? grid[(iy + 1) * columns + ix] : null
			];
			for (const [index, neighbour] of neighbours.entries()) {
				if (!neighbour || neighbour.armorBase !== null) continue;
				const partner = partners[index];
				if (!partner) continue;
				const p1 = positionOf(ix, iy);
				const p2 = index === 0 ? positionOf(ix + 1, iy) : positionOf(ix, iy + 1);
				const top1 = zoneBuilders.armor.vertex(p1.x, p1.y, a.z);
				const top2 = zoneBuilders.armor.vertex(p2.x, p2.y, a.z);
				const low2 = zoneBuilders.armor.vertex(p2.x, p2.y, a.armorBase);
				const low1 = zoneBuilders.armor.vertex(p1.x, p1.y, a.armorBase);
				zoneBuilders.armor.quad(top1, top2, low2, low1);
			}
		}
	}

	// Close the solid where the works stop: drop a wall from the design surface
	// to the existing surface along every open edge of the footprint.
	const edgeWall = (
		first: { ix: number; iy: number; cell: Cell },
		second: { ix: number; iy: number; cell: Cell }
	): void => {
		const p1 = positionOf(first.ix, first.iy);
		const p2 = positionOf(second.ix, second.iy);
		const topA = skirt.vertex(p1.x, p1.y, first.cell.z);
		const topB = skirt.vertex(p2.x, p2.y, second.cell.z);
		const bottomB = skirt.vertex(p2.x, p2.y, Math.min(second.cell.base, second.cell.z));
		const bottomA = skirt.vertex(p1.x, p1.y, Math.min(first.cell.base, first.cell.z));
		skirt.quad(topA, topB, bottomB, bottomA);
	};

	for (let iy = 0; iy < rows; iy++) {
		for (let ix = 0; ix < columns; ix++) {
			const current = grid[iy * columns + ix];
			if (!current) continue;
			const right = ix + 1 < columns ? grid[iy * columns + ix + 1] : null;
			const down = iy + 1 < rows ? grid[(iy + 1) * columns + ix] : null;
			if (iy + 1 < rows && down && (ix === 0 || !grid[iy * columns + ix - 1])) {
				edgeWall({ ix, iy, cell: current }, { ix, iy: iy + 1, cell: down });
			}
			if (iy + 1 < rows && down && (ix === columns - 1 || !grid[iy * columns + ix + 1])) {
				edgeWall({ ix, iy: iy + 1, cell: down }, { ix, iy, cell: current });
			}
			if (ix + 1 < columns && right && (iy === 0 || !grid[(iy - 1) * columns + ix])) {
				edgeWall({ ix: ix + 1, iy, cell: right }, { ix, iy, cell: current });
			}
			if (ix + 1 < columns && right && (iy === rows - 1 || !grid[(iy + 1) * columns + ix])) {
				edgeWall({ ix, iy, cell: current }, { ix: ix + 1, iy, cell: right });
			}
		}
	}

	const meshes: SurfaceMesh[] = [];
	for (const zone of ['armor', 'crest', 'platform'] as const) {
		const builder = zoneBuilders[zone];
		if (builder.empty) continue;
		const style = ZONE_STYLE[zone];
		meshes.push(builder.finish(style.id, style.label, style.color, 1, false));
	}
	if (!skirt.empty) {
		meshes.push(skirt.finish('skirt', 'Fill against the existing bed', 0xa9946a, 1, true));
	}

	const seabedMesh = buildSeabedMesh(model, model.settings.maxSeabedVertices ?? 600_000);
	if (seabedMesh) meshes.push(seabedMesh);
	const subGradeMesh = buildSubGradeMesh(model, sampler, cell);
	if (subGradeMesh) meshes.push(subGradeMesh);
	const structureMesh = buildStructureMesh(model, sampler, cell);
	if (structureMesh) meshes.push(structureMesh);
	const landMesh = buildExistingLandMesh(model);
	if (landMesh) meshes.push(landMesh);
	const lagoonMesh = buildLagoonMesh(model);
	if (lagoonMesh) meshes.push(lagoonMesh);
	const contextMesh = buildContextMesh(model);
	if (contextMesh) meshes.push(contextMesh);
	const seaMesh = buildSeaMesh(model);
	if (seaMesh) meshes.push(seaMesh);

	let vertexCount = 0;
	let triangleCount = 0;
	for (const mesh of meshes) {
		vertexCount += mesh.positions.length / 3;
		triangleCount += mesh.indices.length / 3;
	}

	return {
		meshes,
		cuts: buildSectionCutLines(model, sampler),
		bounds: model.bounds,
		renderCellM: cell,
		vertexCount,
		triangleCount
	};
}

/**
 * The surveyed bed, at the survey's own resolution.
 *
 * The bed is measured data: decimating it would draw a smoother seabed than the
 * one the volumes were integrated against. It is only thinned when the survey is
 * dense enough to blow the vertex budget, and the applied step is reported.
 */
/**
 * The ground dug out below the existing bed.
 *
 * A section that drops a sand key or a rock trench below the seabed is
 * describing excavation: the works are keyed into the bed rather than resting
 * on it, and along an armoured face that key is what stops the toe walking. The
 * integrator has always measured it — it is in `excavation` and in the sand key
 * line — but the drawn solid stopped dead at the bed, so the one part of the
 * design that is *underneath* everything else was the part you could not see.
 *
 * Drawn as the trench itself: the invert, and the walls up to the bed.
 */
function buildSubGradeMesh(
	model: StitchedModel,
	sampler: ReturnType<typeof createSampler>,
	cell: number
): SurfaceMesh | null {
	if (!sampler.subGradeAt) return null;
	const spanX = Math.max(1, sampler.maxX - sampler.minX);
	const spanY = Math.max(1, sampler.maxY - sampler.minY);
	const reach = Math.ceil(sampler.seawardReachM / cell + 1) * cell;
	const minX = sampler.minX - reach;
	const minY = sampler.minY - reach;
	const columns = Math.max(2, Math.round((spanX + 2 * reach) / cell) + 1);
	const rows = Math.max(2, Math.round((spanY + 2 * reach) / cell) + 1);
	if (columns * rows > 4_000_000) return null;

	type Dig = { readonly invert: number; readonly bed: number };
	const grid: (Dig | null)[] = new Array(columns * rows).fill(null);
	const at = (ix: number, iy: number) => ({ x: minX + ix * cell, y: minY + iy * cell });

	let any = false;
	for (let iy = 0; iy < rows; iy++) {
		for (let ix = 0; ix < columns; ix++) {
			const { x, y } = at(ix, iy);
			const bands = sampler.subGradeAt(x, y);
			if (bands.length === 0) continue;
			const bed = sampler.bedAt(x, y);
			// The deepest invert is the floor of the excavation; shallower bands sit
			// inside it and would only z-fight with their own trench walls.
			let invert = Infinity;
			for (const band of bands) invert = Math.min(invert, band.invertM);
			if (!Number.isFinite(invert) || invert >= bed) continue;
			grid[iy * columns + ix] = { invert, bed };
			any = true;
		}
	}
	if (!any) return null;

	const builder = new MeshBuilder();
	const cache = new Map<string, number>();
	const vertex = (ix: number, iy: number, z: number, tag: string): number => {
		const key = `${tag}:${ix}:${iy}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const { x, y } = at(ix, iy);
		const index = builder.vertex(x, y, z);
		cache.set(key, index);
		return index;
	};

	for (let iy = 0; iy < rows - 1; iy++) {
		for (let ix = 0; ix < columns - 1; ix++) {
			const a = grid[iy * columns + ix];
			const b = grid[iy * columns + ix + 1];
			const c = grid[(iy + 1) * columns + ix + 1];
			const d = grid[(iy + 1) * columns + ix];
			if (!a || !b || !c || !d) continue;
			// Floor of the trench.
			builder.quad(
				vertex(ix, iy, a.invert, 'floor'),
				vertex(ix, iy + 1, d.invert, 'floor'),
				vertex(ix + 1, iy + 1, c.invert, 'floor'),
				vertex(ix + 1, iy, b.invert, 'floor')
			);
		}
	}

	// Walls wherever the trench stops, from its invert up to the existing bed.
	for (let iy = 0; iy < rows; iy++) {
		for (let ix = 0; ix < columns; ix++) {
			const current = grid[iy * columns + ix];
			if (!current) continue;
			const right = ix + 1 < columns ? grid[iy * columns + ix + 1] : null;
			const down = iy + 1 < rows ? grid[(iy + 1) * columns + ix] : null;
			if (down && !right && ix + 1 < columns) {
				builder.quad(
					vertex(ix, iy, current.bed, 'bed'),
					vertex(ix, iy + 1, down.bed, 'bed'),
					vertex(ix, iy + 1, down.invert, 'floor'),
					vertex(ix, iy, current.invert, 'floor')
				);
			}
			if (right && !down && iy + 1 < rows) {
				builder.quad(
					vertex(ix, iy, current.invert, 'floor'),
					vertex(ix + 1, iy, right.invert, 'floor'),
					vertex(ix + 1, iy, right.bed, 'bed'),
					vertex(ix, iy, current.bed, 'bed')
				);
			}
		}
	}

	if (builder.empty) return null;
	return builder.finish('subgrade', 'Excavated below the bed', 0x8a6f4a, 1, true);
}

function buildSeabedMesh(model: StitchedModel, maxVertices: number): SurfaceMesh | null {
	const { seabed } = model;
	const step = Math.max(1, Math.ceil(Math.sqrt((seabed.nx * seabed.ny) / maxVertices)));
	const stepX = step;
	const stepY = step;
	const builder = new MeshBuilder();
	const indexGrid: number[] = [];
	let rowCount = 0;
	let columnCount = 0;
	for (let iy = 0; iy < seabed.ny; iy += stepY) {
		columnCount = 0;
		for (let ix = 0; ix < seabed.nx; ix += stepX) {
			indexGrid.push(
				builder.vertex(
					seabed.x0 + ix * seabed.dx,
					seabed.y0 + iy * seabed.dy,
					seabed.z[iy * seabed.nx + ix]
				)
			);
			columnCount += 1;
		}
		rowCount += 1;
	}
	if (rowCount < 2 || columnCount < 2) return null;
	for (let row = 0; row < rowCount - 1; row++) {
		for (let column = 0; column < columnCount - 1; column++) {
			builder.quad(
				indexGrid[row * columnCount + column],
				indexGrid[row * columnCount + column + 1],
				indexGrid[(row + 1) * columnCount + column + 1],
				indexGrid[(row + 1) * columnCount + column]
			);
		}
	}
	return builder.finish('seabed', 'Surveyed bed', 0x4c5a52, 1, true);
}

function buildStructureMesh(
	model: StitchedModel,
	sampler: SiteSampler,
	cell: number
): SurfaceMesh | null {
	if (!sampler.structureAt) return null;
	const builder = new MeshBuilder();
	for (const structure of model.plan.structures) {
		for (const part of structure.parts) {
			let minX = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const [x, y] of part.polygon) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
			const ratio = model.params.slopes[part.faceSlopeKey] ?? model.params.slopes.seaward;
			const runFactor = ratio && ratio.v > 0 ? ratio.h / ratio.v : 3;
			const margin = Math.max(0, (part.crestZM - model.bounds.minZ) * runFactor);
			minX -= margin;
			maxX += margin;
			minY -= margin;
			maxY += margin;
			const columns = Math.max(2, Math.round((maxX - minX) / cell) + 1);
			const rows = Math.max(2, Math.round((maxY - minY) / cell) + 1);
			const indexGrid: (number | null)[] = [];
			for (let iy = 0; iy < rows; iy++) {
				for (let ix = 0; ix < columns; ix++) {
					const x = minX + (ix * (maxX - minX)) / (columns - 1);
					const y = minY + (iy * (maxY - minY)) / (rows - 1);
					const bed = sampler.bedAt(x, y);
					const top = sampler.structureAt(x, y, bed);
					indexGrid.push(top === undefined ? null : builder.vertex(x, y, top));
				}
			}
			for (let iy = 0; iy < rows - 1; iy++) {
				for (let ix = 0; ix < columns - 1; ix++) {
					const a = indexGrid[iy * columns + ix];
					const b = indexGrid[iy * columns + ix + 1];
					const c = indexGrid[(iy + 1) * columns + ix + 1];
					const d = indexGrid[(iy + 1) * columns + ix];
					if (a === null || b === null || c === null || d === null) continue;
					builder.quad(a, b, c, d);
				}
			}
		}
	}
	if (builder.empty) return null;
	return builder.finish('structure', 'Pre-existing embankment', 0x8a7f6a, 0.85, true);
}

function buildExistingLandMesh(model: StitchedModel): SurfaceMesh | null {
	const polygon = model.plan.existingLandPolygon;
	if (!polygon || polygon.length < 3) return null;
	const level = model.plan.existingLandLevelM ?? model.params.levelsM.platform;
	const builder = new MeshBuilder();
	addFlatPolygon(builder, polygon, level);
	if (builder.empty) return null;
	return builder.finish('existing_land', 'Existing land', 0x6b7a55, 1, true);
}

/**
 * Containment ponds, drawn as a flat water surface just above the sea plane so
 * the void inside the bund reads as water rather than as a hole in the pad.
 */
function buildLagoonMesh(model: StitchedModel): SurfaceMesh | null {
	const lagoons = model.plan.lagoonPolygons ?? [];
	if (lagoons.length === 0) return null;
	const level = model.params.levelsM.sea + 0.4;
	const builder = new MeshBuilder();
	for (const polygon of lagoons) {
		if (polygon.length >= 3) addFlatPolygon(builder, polygon, level);
	}
	if (builder.empty) return null;
	return builder.finish('lagoon', 'Containment pond', 0x2c7a72, 0.75, true);
}

/**
 * Neighbouring or future works, drawn flat at platform level.
 *
 * Context exists so the site reads in its setting — an adjacent phase, an
 * adjoining terminal. It is never integrated and never priced, and it is a
 * separate toggle so it can be switched off when reviewing the works alone.
 */
function buildContextMesh(model: StitchedModel): SurfaceMesh | null {
	const context = model.plan.contextPolygons ?? [];
	if (context.length === 0) return null;
	const level = model.params.levelsM.platform;
	const builder = new MeshBuilder();
	for (const entry of context) {
		if (entry.polygon.length >= 3) addFlatPolygon(builder, entry.polygon, level);
	}
	if (builder.empty) return null;
	return builder.finish('context', 'Adjacent and future works', 0x8f9aa3, 0.5, true);
}

function buildSeaMesh(model: StitchedModel): SurfaceMesh | null {
	const { bounds } = model;
	const level = model.params.levelsM.sea;
	// A generous margin so the water reads as open sea around the whole setting.
	const builder = new MeshBuilder();
	const padX = (bounds.maxX - bounds.minX) * 0.15;
	const padY = (bounds.maxY - bounds.minY) * 0.15;
	const a = builder.vertex(bounds.minX - padX, bounds.minY - padY, level);
	const b = builder.vertex(bounds.maxX + padX, bounds.minY - padY, level);
	const c = builder.vertex(bounds.maxX + padX, bounds.maxY + padY, level);
	const d = builder.vertex(bounds.minX - padX, bounds.maxY + padY, level);
	builder.quad(a, b, c, d);
	return builder.finish('sea', 'Water plane', 0x2f5d70, 0.35, true);
}

function buildSectionCutLines(model: StitchedModel, sampler: SiteSampler): SectionCutLine[] {
	const cuts: SectionCutLine[] = [];
	for (const cut of model.plan.sectionCuts) {
		const start = cut.line[0];
		const end = cut.line[cut.line.length - 1];
		const steps = 128;
		const points = new Float32Array((steps + 1) * 3);
		for (let step = 0; step <= steps; step++) {
			const t = step / steps;
			const x = start[0] + (end[0] - start[0]) * t;
			const y = start[1] + (end[1] - start[1]) * t;
			const works = sampler.worksAt(x, y);
			const z = works ? works.z : sampler.bedAt(x, y);
			points[step * 3] = x;
			points[step * 3 + 1] = y;
			points[step * 3 + 2] = z + 0.35;
		}
		cuts.push({ id: cut.id, label: `Section ${cut.id}`, points });
	}
	return cuts;
}
