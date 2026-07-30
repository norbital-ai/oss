/**
 * What-if levers that change the *solid*, not just the price.
 *
 * A commercial lever multiplies a quantity. These change the geometry the
 * quantity is measured from, so the answer comes back through the same
 * integrator that produced the original take-off — there is no parallel
 * estimating path that could disagree with it.
 *
 * Every lever is applied by an exact edit to the stitched model, so the result
 * is the volume of a real alternative design rather than a factor on the base
 * case. Applying one and re-integrating is the whole mechanism.
 */

import type { ProfilePoint, SeabedGrid, StitchedModel } from './types.js';
import { topSurfaceFromProfile } from './surface.js';
import { isSurfaceLayer } from './profile-layers.js';

export type GeometrySimulation = {
	/**
	 * Shift the surveyed bed. Models survey tolerance, post-dredge levels, or
	 * settlement under the fill. Positive raises the bed and reduces fill.
	 */
	readonly bedOffsetM: number;
	/**
	 * Raise or lower the whole finished works. The section translates vertically,
	 * so every slope and width is preserved exactly.
	 */
	readonly platformOffsetM: number;
	/**
	 * Widen or steepen the seaward face. Stations up to the crest scale by this
	 * factor and everything landward shifts by the same amount, so the face
	 * changes batter while the platform keeps its width.
	 */
	readonly faceRunFactor: number;
	/** Armour blanket thickness, perpendicular to the face. */
	readonly armorThicknessM: number;
	/** Deepen or raise every sub-grade invert — sand keys, foundation trenches. */
	readonly subGradeOffsetM: number;
};

export const NO_SIMULATION: GeometrySimulation = {
	bedOffsetM: 0,
	platformOffsetM: 0,
	faceRunFactor: 1,
	armorThicknessM: Number.NaN,
	subGradeOffsetM: 0
};

export function isIdentity(simulation: GeometrySimulation): boolean {
	return (
		simulation.bedOffsetM === 0 &&
		simulation.platformOffsetM === 0 &&
		simulation.faceRunFactor === 1 &&
		simulation.subGradeOffsetM === 0 &&
		Number.isNaN(simulation.armorThicknessM)
	);
}

/** Base levers for a model, so a panel opens on the design as drawn. */
export function baseSimulation(model: StitchedModel): GeometrySimulation {
	return { ...NO_SIMULATION, armorThicknessM: model.params.dimensionsM.armorThickness };
}

function shiftBed(seabed: SeabedGrid, offset: number): SeabedGrid {
	if (offset === 0) return seabed;
	return { ...seabed, z: seabed.z.map((value) => value + offset) };
}

/**
 * Apply the levers to one section.
 *
 * Surface points translate vertically and their face stations scale about the
 * toe; below-grade points translate vertically by the sub-grade offset. The
 * crest station is read from the section itself, so the split between "face" and
 * "platform" follows the drawing rather than a fixed number.
 */
function adjustProfile(
	id: string,
	points: readonly ProfilePoint[],
	simulation: GeometrySimulation,
	layerOverrides: Parameters<typeof isSurfaceLayer>[1]
): ProfilePoint[] {
	let crestEnd = 0;
	try {
		crestEnd = topSurfaceFromProfile(id, points, layerOverrides).crestEndStation;
	} catch {
		crestEnd = 0;
	}
	const factor = simulation.faceRunFactor;
	const shift = crestEnd * (factor - 1);

	return points.map((point) => {
		const surface = isSurfaceLayer(point.layer, layerOverrides);
		const station = point.stationM <= crestEnd ? point.stationM * factor : point.stationM + shift;
		return {
			stationM: station,
			zCdM: point.zCdM + (surface ? simulation.platformOffsetM : simulation.subGradeOffsetM),
			layer: point.layer
		};
	});
}

/**
 * Return the model this simulation describes.
 *
 * Pure: the original is untouched, so a panel can hold the base model and
 * re-derive any number of alternatives from it.
 */
export function applySimulation(
	model: StitchedModel,
	simulation: GeometrySimulation
): StitchedModel {
	if (isIdentity(simulation)) return model;

	const layerOverrides = model.classification.layerOverrides;
	const profiles: Record<string, ProfilePoint[]> = {};
	for (const [id, points] of Object.entries(model.profiles)) {
		profiles[id] = adjustProfile(id, points, simulation, layerOverrides);
	}

	const armorThickness = Number.isNaN(simulation.armorThicknessM)
		? model.params.dimensionsM.armorThickness
		: Math.max(0, simulation.armorThicknessM);

	return {
		...model,
		profiles,
		seabed: shiftBed(model.seabed, simulation.bedOffsetM),
		params: {
			...model.params,
			levelsM: {
				...model.params.levelsM,
				toe: model.params.levelsM.toe + simulation.platformOffsetM,
				platform: model.params.levelsM.platform + simulation.platformOffsetM
			},
			dimensionsM: { ...model.params.dimensionsM, armorThickness }
		}
	};
}
