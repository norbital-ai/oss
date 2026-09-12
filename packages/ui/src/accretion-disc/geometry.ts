import {
	TAU,
	clamp,
	pitchAcross,
	smooth,
	type DotGeometry,
	type DotPoint
} from '#lib/dot-field';

/** A dot on the disc or on the photon ring. */
export type DiscSeed = {
	readonly kind: 'disc' | 'ring';
	/** Orbit radius in shadow radii. */
	readonly r: number;
	readonly phi: number;
	/** A far-side dot that is also shown folded under the shadow, as the lower lensed image. */
	readonly lower: boolean;
};

/** The disc's outer edge, in shadow radii; the mark's horizontal reach. */
export const DISC_REACH = 2.6;
const DISC_INNER = 1.15;
const RING_RADIUS = 0.9;
/** Sine of the disc's inclination: nearly edge-on. */
const INCLINATION = 0.34;

/**
 * A lattice, not a cloud: rings of evenly spaced dots, each ring turning rigidly at its own rate,
 * so the field stays crisp the way a dotted globe's rings do. Ring spacing and dot pitch both
 * clear the largest dot, so nothing overlaps.
 */
export function discLayout(size: number): DiscSeed[] {
	const pxPerUnit = (size * 0.46) / DISC_REACH;
	const pitchPx = pitchAcross(size);
	const pitch = pitchPx / pxPerUnit;
	const rings = Math.max(4, Math.round(((DISC_REACH - DISC_INNER) * pxPerUnit) / (pitchPx * 1.2)) + 1);
	const seeds: DiscSeed[] = [];
	for (let k = 0; k < rings; k += 1) {
		const r = DISC_INNER + (DISC_REACH - DISC_INNER) * (k / (rings - 1));
		const n = Math.max(10, Math.round((TAU * r) / pitch));
		const offset = (k % 2) * (Math.PI / n) + k * 0.13;
		for (let i = 0; i < n; i += 1) {
			seeds.push({ kind: 'disc', r, phi: (i / n) * TAU + offset, lower: false });
			if (k < 3 && i % 3 === 0) {
				seeds.push({ kind: 'disc', r, phi: (i / n) * TAU + offset + Math.PI / n, lower: true });
			}
		}
	}
	const m = Math.max(10, Math.round((TAU * RING_RADIUS) / pitch));
	for (let i = 0; i < m; i += 1) {
		seeds.push({ kind: 'ring', r: RING_RADIUS, phi: (i / m) * TAU, lower: false });
	}
	return seeds;
}

/**
 * Places one dot on its orbit.
 *
 * Every quantity is one smooth function of the orbit angle: the far side's lift over the shadow
 * eases in from the crossing instead of switching branches there, and depth follows sin(φ), so a
 * dot's size, ink and draw order all change continuously as it goes round.
 */
export function discPoint(_state: 'ready', seed: DiscSeed, _index: number, time: number): DotPoint {
	const point = discPlace(seed, time);
	// The whole disc rolls slowly, so its outline keeps changing.
	const roll = 0.05 * Math.sin(time * 0.45);
	const cr = Math.cos(roll);
	const sr = Math.sin(roll);
	const x = point.x * cr - point.y * sr;
	const y = point.x * sr + point.y * cr;
	point.x = x;
	point.y = y;
	return point;
}

function discPlace(seed: DiscSeed, time: number): DotPoint {
	if (seed.kind === 'ring') {
		// A circle in the same tilted space as the disc: top behind, bottom in front, so the ring
		// is sized and inked with the depth the disc has rather than pasted flat over it.
		const phi = seed.phi + time * 1.6;
		return {
			x: seed.r * Math.cos(phi),
			y: seed.r * Math.sin(phi) * 0.9,
			z: 0.3 - 0.6 * Math.sin(phi),
			light: 1,
			accent: 0,
			boost: 0.25,
			vis: 1
		};
	}
	const r = seed.r;
	// Shallower than Keplerian: neighbouring rings drift apart slowly, so no moiré beats.
	const phi = seed.phi + (time * 0.55) / r;
	const s = Math.sin(phi);
	const c = Math.cos(phi);
	const heat = clamp((DISC_REACH - r) / (DISC_REACH - DISC_INNER));
	const far = smooth(s);
	// The disc rocks and its lensed arc ripples: a surface, not a diagram.
	const flat = r * INCLINATION * (1 + 0.22 * Math.sin(time * 0.5));
	const ripple = 1 + 0.05 * Math.sin(r * 4 - time * 0.9);
	if (seed.lower) {
		return {
			x: r * c * (1 - 0.1 * far),
			y: -(1.0 + 0.12 * (r - 1)) * s,
			z: -0.9,
			light: 1,
			accent: 0,
			boost: 0,
			vis: 0.7 * smooth(s * 3)
		};
	}
	// Lensed images of the far side pile up just outside the photon ring: the arc hugs the ring
	// and opens slowly with r instead of stacking full circles.
	const lift = (1.08 + 0.4 * Math.pow(r - DISC_INNER, 0.9)) * ripple - flat;
	const y = s * (flat + lift * far) + 0.1 * Math.min(0, s) * clamp(Math.pow(1.3 / r, 2));
	// The approaching side beams brighter.
	const beam = 0.8 + 0.3 * -c;
	return { x: r * c, y, z: -0.8 * s, light: beam, accent: 0, boost: heat * 0.2, vis: 1 };
}

export const accretionDiscGeometry: DotGeometry<DiscSeed, 'ready'> = {
	states: ['ready'],
	layout: discLayout,
	point: discPoint
};
