import {
	RIBBON_BELOW,
	TAU,
	angleDistance,
	clamp,
	markRadius,
	noise,
	pitchAcross,
	pitchAlong,
	rotate,
	type DotGeometry,
	type DotPoint
} from '#lib/dot-field';

/**
 * What the strip says, in the states a reader can actually act on.
 *
 * `ready`, `working` and `error` are the original three. `waiting`, `done` and `stopped` exist
 * because the canonical Task lifecycle has six members and projecting them onto three told a lie
 * in two places: an agent parked on an approval rendered as an agent that had broken, and a
 * finished turn rendered as one that had never run.
 */
export const NORBIUS_STRIP_STATES = [
	'ready',
	'working',
	'waiting',
	'done',
	'stopped',
	'error'
] as const;
export type NorbiusStripState = (typeof NORBIUS_STRIP_STATES)[number];

/** A place on the band: `u` along it, `v` across it in [-1, 1]. */
export type BandSeed = {
	readonly u: number;
	readonly v: number;
	readonly edge: boolean;
	/** Icon-size adjustments, carried on the seed so `point` stays size-blind. */
	readonly wide: number;
	readonly lift: number;
};

/**
 * Each state owns a silhouette, not just a speed.
 *
 * Speed alone is invisible in a still frame and at 16px, which is exactly where this mark is read.
 * `tilt` and `twist` differ per state — flat to finish, fallen over to stop — and the accent then
 * says which of the near ones this is. Every silhouette is seated afterwards, so none is larger.
 */
type BandConfig = {
	readonly turn: number;
	readonly tilt: number;
	readonly width: number;
	readonly twist: number;
	readonly breath: number;
	/** How far a wave along the band lifts the surface off its plane. */
	readonly flex: number;
	/** How far the whole band rocks. */
	readonly sway: number;
};
const BAND: Record<NorbiusStripState, BandConfig> = {
	ready: { turn: 0.32, tilt: 0.72, width: 0.42, twist: 1, breath: 0, flex: 0.14, sway: 0.14 },
	working: { turn: 1.15, tilt: 0.72, width: 0.42, twist: 1, breath: 0.02, flex: 0.22, sway: 0.18 },
	waiting: { turn: 0.05, tilt: 0.72, width: 0.42, twist: 1, breath: 0.045, flex: 0.08, sway: 0.06 },
	done: { turn: 0.18, tilt: 1.15, width: 0.26, twist: 0, breath: 0, flex: 0, sway: 0.04 },
	// Fallen over: the same twisted band, at rest and almost edge-on, like a top that stopped.
	stopped: { turn: 0, tilt: 0.2, width: 0.42, twist: 1, breath: 0, flex: 0, sway: 0 },
	error: { turn: 0.55, tilt: 0.72, width: 0.42, twist: 1, breath: 0, flex: 0.16, sway: 0.1 }
};

const CENTRE_RADIUS = 0.78;
/** The band's reach in shape units at rest, used to turn px pitches into counts. */
const REACH = 1.15;

/** The seed grid, ring-major: index = ring · across + column. `faces` needs the shape back. */
export type BandLayout = BandSeed[] & { readonly around: number; readonly across: number };

/**
 * Rows of dots along the band, as many as the pixel pitch allows.
 *
 * Below `RIBBON_BELOW` a faint ribbon is drawn under the dots, and the band is exaggerated to be
 * read at that size: a third wider, seen a touch more from above so the loop closes visibly, and
 * with only a few rows so each one resolves.
 */
export function bandLayout(size: number): BandLayout {
	const ribbon = size < RIBBON_BELOW;
	const wide = ribbon ? 1.35 : 1;
	const lift = ribbon ? 0.12 : 0;
	const unit = (markRadius(size) * size) / REACH;
	const ringPx = CENTRE_RADIUS * unit;
	const bandPx = 2 * 0.42 * wide * unit;
	const around = Math.max(12, Math.round((TAU * ringPx) / pitchAlong(size)));
	const across = ribbon
		? clamp(Math.round(bandPx / (pitchAcross(size) * 1.6)) + 1, 3, 5)
		: clamp(Math.round(bandPx / pitchAcross(size)) + 1, 3, 9);
	const step = TAU / around;
	const seeds = Object.assign([] as BandSeed[], { around, across });
	for (let ring = 0; ring < around; ring += 1) {
		for (let column = 0; column < across; column += 1) {
			const v = (column / (across - 1)) * 2 - 1;
			seeds.push({
				u: ring * step + (column % 2) * (step / 2),
				v,
				edge: Math.abs(v) === 1,
				wide,
				lift
			});
		}
	}
	return seeds;
}

/**
 * The surface between the two edges, one quad per ring: `[edge- at r, edge- at r+1, edge+ at
 * r+1, edge+ at r]`.
 *
 * On a Möbius band an edge returns as its mirror after one turn, so at the seam the edges swap;
 * a flat ring closes onto itself.
 */
export function bandFaces(
	seeds: BandSeed[],
	state: NorbiusStripState
): ReadonlyArray<readonly [number, number, number, number]> {
	const { around, across } = seeds as BandLayout;
	const mirror = BAND[state].twist > 0.5;
	const faces: Array<readonly [number, number, number, number]> = [];
	for (let ring = 0; ring < around; ring += 1) {
		const nextRing = (ring + 1) % around;
		const swap = nextRing === 0 && mirror;
		const a = ring * across;
		const d = ring * across + across - 1;
		const b = nextRing * across + (swap ? across - 1 : 0);
		const c = nextRing * across + (swap ? 0 : across - 1);
		faces.push([a, b, c, d]);
	}
	return faces;
}

/**
 * The band is a ribbon, so it is allowed to flex.
 *
 * A slow wave runs along it, lifting the surface off its plane and breathing its radius, so the
 * silhouette keeps changing — which is what makes a small mark noticeable. Every point is seated
 * afterwards, so the mark can move this much without changing size in its box.
 */
function surface(
	config: BandConfig,
	u: number,
	v: number,
	width: number,
	time: number
): [number, number, number] {
	const half = (u * config.twist) / 2;
	const wave = Math.sin(u * 2 - time * 1.3) * 0.65 + Math.sin(u * 3 + time * 0.8) * 0.35;
	const r =
		(CENTRE_RADIUS + v * width * Math.cos(half)) *
		(1 + config.flex * 0.35 * Math.sin(u * 3 - time * 1.1));
	return [r * Math.cos(u), v * width * Math.sin(half) + config.flex * wave, r * Math.sin(u)];
}

/** Places one band particle: shaded by its surface normal, then accented per state. */
export function bandPoint(
	state: NorbiusStripState,
	seed: BandSeed,
	index: number,
	time: number
): DotPoint {
	const config = BAND[state];
	const u = seed.u + time * config.turn;
	const width = config.width * seed.wide * (1 + config.breath * Math.sin(time * 2.2));
	const p = surface(config, u, seed.v, width, time);
	const pu = surface(config, u + 1e-3, seed.v, width, time);
	const pv = surface(config, u, seed.v + 1e-3, width, time);
	const ax = pu[0] - p[0];
	const ay = pu[1] - p[1];
	const az = pu[2] - p[2];
	const bx = pv[0] - p[0];
	const by = pv[1] - p[1];
	const bz = pv[2] - p[2];
	let nx = ay * bz - az * by;
	let ny = az * bx - ax * bz;
	let nz = ax * by - ay * bx;
	const length = Math.hypot(nx, ny, nz) || 1;
	nx /= length;
	ny /= length;
	nz /= length;
	const yaw = Math.sin(time * 0.37) * 0.14;
	// The whole band rocks, so its outline changes even where the wave is small.
	const tilt = config.tilt + seed.lift + Math.sin(time * 0.9) * config.sway;
	const placed = rotate(p[0], p[1], p[2], tilt, yaw);
	const normal = rotate(nx, ny, nz, tilt, yaw);
	const point: DotPoint = {
		x: placed.x,
		y: placed.y,
		z: placed.z,
		light: Math.abs(normal.z),
		accent: 0,
		boost: seed.edge ? 0.12 : 0,
		vis: 1
	};
	const depth = clamp(point.z * 1.4 + 0.3);

	if (state === 'ready') {
		// One glint of brand light sweeping the band: idling, not stalled.
		const d = angleDistance(u, time * 0.9);
		point.accent = Math.exp(-(d * d) / 0.14) * depth * 1.2;
	} else if (state === 'working') {
		// Two currents crossing, quick: a transition should look like it is already moving.
		const a = angleDistance(u, time * 2.6 + seed.v * 1.2);
		const b = angleDistance(u, -time * 1.9 + Math.PI);
		point.accent = Math.max(Math.exp(-(a * a) / 0.1), Math.exp(-(b * b) / 0.12) * 0.7) * depth;
		point.boost += point.accent * 0.2;
	} else if (state === 'waiting') {
		// The turn all but stops and the light gathers and breathes at the twist. A held breath,
		// not a failure: still brand, never destructive.
		const near = Math.exp(-(angleDistance(u, Math.PI) ** 2) / 0.3);
		point.accent = near * (0.55 + 0.45 * Math.sin(time * 1.9)) * (0.5 + depth * 0.5);
		point.boost += point.accent * 0.3;
		point.vis *= 0.55 + 0.45 * near;
	} else if (state === 'done') {
		// A flush that fills the flat ring and decays: the shape settling, not dying.
		const cycle = (time * 0.28) % 1;
		const flush = Math.exp(-((cycle - 0.15) ** 2) / 0.02) + 0.08;
		point.accent = clamp(flush) * (0.4 + depth * 0.6) * 0.8;
		point.vis *= 0.85;
	} else if (state === 'stopped') {
		point.vis *= 0.6;
	} else {
		// Comes apart and back together, rather than melting away: the agent has not died, one
		// turn did. Legible as broken and as recoverable at the same time.
		const burst = (time * 0.85 + index * 0.0007) % 1;
		const scatter = Math.sin(Math.PI * burst) ** 1.6;
		const jitter = noise(index, 9) * 0.5;
		const spread = 1 + scatter * (0.55 + jitter * 0.35);
		point.x *= spread;
		point.y *= spread;
		point.z *= spread;
		point.accent = 1;
		point.boost = 0.1 + scatter * 0.3;
		point.vis *= 0.45 + (1 - scatter) * 0.55;
	}
	return point;
}

export const norbiusStripGeometry: DotGeometry<BandSeed, NorbiusStripState> = {
	states: NORBIUS_STRIP_STATES,
	layout: bandLayout,
	point: bandPoint,
	faces: bandFaces
};
