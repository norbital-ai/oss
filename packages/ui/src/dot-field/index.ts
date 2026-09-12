/**
 * The dot-field engine shared by `NorbiusStrip` and `AccretionDisc`.
 *
 * A mark is a set of seeds and a function that places each seed at a time, in a state. This module
 * owns everything else: how dots are sized and inked (the thinking-orbs vocabulary — matte, opaque,
 * monochrome dots, near ones larger and full ink, far ones smaller and faint, z-sorted so the near
 * lattice sits on top), how a shape is seated in its box, and the frame loop that draws it.
 *
 * Scale is one rule, continuous in size so a ladder has no steps in it: a dot never grows past
 * ~1.2px, and a bigger box gets more dots on a fixed pixel pitch. Below ~32px the pitch along the
 * band is tighter than the pitch across it, so rows fuse into contour rails and the mark reads as
 * a surface; the two pitches meet past 128px, where it is an open lattice.
 */

export const TAU = Math.PI * 2;

/** Clamps a numeric value to the inclusive range between min and max. */
export function clamp(value: number, min = 0, max = 1): number {
	return Math.min(max, Math.max(min, value));
}

/** Hermite ease of a value clamped to [0, 1]. */
export function smooth(value: number): number {
	const c = clamp(value);
	return c * c * (3 - 2 * c);
}

/** Returns the shortest signed angular distance between two radians. */
export function angleDistance(a: number, b: number): number {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Deterministic scatter in [-1, 1]; a seed set has to be stable across frames. */
export function noise(index: number, salt: number): number {
	const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
	return (value - Math.floor(value)) * 2 - 1;
}

/** Applies yaw about y then tilt about x. */
export function rotate(
	x: number,
	y: number,
	z: number,
	tilt: number,
	yaw: number
): { x: number; y: number; z: number } {
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const x1 = x * cy + z * sy;
	const z1 = -x * sy + z * cy;
	const ct = Math.cos(tilt);
	const st = Math.sin(tilt);
	return { x: x1, y: y * ct - z1 * st, z: y * st + z1 * ct };
}

/* ---------- Scale rules (CSS px) ---------- */

/** Dot pitch across a band's width. */
export const pitchAcross = (size: number): number => clamp(1 + (size - 16) * 0.02, 1, 3.4);
/** Dot pitch along a band's length: tighter, so rows fuse into rails at icon size. */
export const pitchAlong = (size: number): number => clamp(0.8 + (size - 16) * 0.022, 0.8, 3.4);
/** Radius of a dot at the front. */
export const dotNear = (size: number): number => clamp(0.75 + (size - 16) * 0.0056, 0.75, 1.2);
/** Radius of a dot at the back. At icon size it matches the front, so depth is carried by ink. */
export const dotFar = (size: number): number => clamp(0.55 - (size - 16) * 0.003, 0.45, 0.55);
/** Ink strength of a dot at the back, as a fraction of full ink. */
export const INK_FLOOR = 0.26;
/**
 * The drawn mark's radius as a fraction of its box: a full 46% at icon size, where it has to hold
 * its own beside 16px glyphs, easing to 36% where it has room to sit like a stroke icon does.
 */
export const markRadius = (size: number): number => clamp(0.5 - (size - 20) * 0.005, 0.36, 0.5);

/* ---------- Geometry contract ---------- */

/** One placed particle, in shape units, before seating. */
export type DotPoint = {
	x: number;
	y: number;
	/** Depth in roughly [-1, 1]; sizes and inks the dot, and orders the draw. */
	z: number;
	/** How squarely the surface faces the viewer, in [0, 1]; dims an edge-on surface. */
	light: number;
	/** Brand-ink mix, in [0, 1]. */
	accent: number;
	/** Extra radius in px, e.g. a band's edge rows. Ignored at icon size. */
	boost: number;
	/** Visibility in [0, 1]; a dot at 0 is neither drawn nor measured. */
	vis: number;
	/**
	 * A point of a solid body rather than a dot: never drawn as one, and a face made only of solid
	 * points is filled opaque black on any ground — a black hole's shadow is black.
	 */
	solid?: boolean;
};

export type DotGeometry<Seed, State extends string> = {
	readonly states: readonly State[];
	layout(size: number): Seed[];
	point(state: State, seed: Seed, index: number, time: number): DotPoint;
	/**
	 * Quads of seed indices — `[a, b, c, d]` with `a→b` and `d→c` running along the surface — that
	 * tile the mark as a ribbon. A geometry that provides this is drawn as a ribbon below
	 * `RIBBON_BELOW`, where its dots could not resolve.
	 */
	faces?(seeds: Seed[], state: State): ReadonlyArray<readonly [number, number, number, number]>;
	/**
	 * The box size below which `faces` are painted as a faint surface under the dots. Defaults to
	 * `RIBBON_BELOW`; a mark that is a surface at every size passes `Infinity`.
	 */
	readonly surfaceBelow?: number;
};

/**
 * Below this box size a dot is under a pixel and a field of them reads as a smudge, so a geometry
 * that can be drawn as a surface is: each patch filled with ink by depth and by how squarely it
 * faces the viewer, its edges outlined. A Möbius band's twist then reads as the shading turning
 * over, the way a solid icon of one does.
 */
export const RIBBON_BELOW = 32;

/** Where a shape sits in the unit box and what it takes to seat it there. */
export type ShapeFit = { cx: number; cy: number; scale: number };

/**
 * Measures one shape over a whole cycle of its own motion: where it sits, and how far it reaches.
 *
 * Sampled once per size rather than per frame on purpose. A per-frame fit would rescale the mark
 * as it turned, and the orb would breathe against the icons beside it.
 */
export function measureFit<Seed, State extends string>(
	geometry: DotGeometry<Seed, State>,
	seeds: Seed[],
	state: State
): ShapeFit {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (let time = 0; time < 15; time += 0.6) {
		for (let index = 0; index < seeds.length; index += 1) {
			const point = geometry.point(state, seeds[index], index, time);
			if (point.vis <= 0) continue;
			minX = Math.min(minX, point.x);
			maxX = Math.max(maxX, point.x);
			minY = Math.min(minY, point.y);
			maxY = Math.max(maxY, point.y);
		}
	}
	// One scale for both axes: fitting each separately would squash a circle into an ellipse.
	const reach = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
	return {
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		scale: reach > 0 && Number.isFinite(reach) ? 1 / reach : 1
	};
}

/* ---------- Colour ---------- */

type Rgb = readonly [number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;
const rgbCache = new Map<string, Rgb>();

/** Resolves any CSS colour the browser can paint to rgb, once. */
function rgb(css: string): Rgb {
	const cached = rgbCache.get(css);
	if (cached) return cached;
	if (probe === undefined) {
		probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
	}
	if (!probe) return [128, 128, 128];
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = css;
	probe.fillRect(0, 0, 1, 1);
	const d = probe.getImageData(0, 0, 1, 1).data;
	const value: Rgb = [d[0], d[1], d[2]];
	rgbCache.set(css, value);
	return value;
}

function mix(a: Rgb, b: Rgb, f: number): Rgb {
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function css(c: Rgb): string {
	return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

/** The nearest painted ancestor background: what far dots fade toward. */
function groundOf(element: Element): string {
	for (let node: Element | null = element; node; node = node.parentElement) {
		const background = getComputedStyle(node).backgroundColor;
		if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
			return background;
		}
	}
	return getComputedStyle(document.body).backgroundColor;
}

/* ---------- Runner ---------- */

export type DotFieldOptions<Seed, State extends string> = {
	readonly geometry: DotGeometry<Seed, State>;
	readonly size: number;
	/** The drawn mark's radius as a fraction of the box. */
	readonly radius: number;
	/** Reads the live state; the runner must not snapshot it. */
	readonly readState: (root: Element) => State;
	/** How long a state change takes to travel, in ms. */
	readonly transitionMs: number;
};

/**
 * Draws a geometry into a canvas until the returned cleanup runs.
 *
 * Handles DPR, theme colours (ink from the canvas's `color`, accent from the swatch's, ground from
 * the nearest painted ancestor), state transitions, visibility and reduced motion. The caller's
 * attach closure passes `size` in and reads `state` through `readState`, so a state change does not
 * re-run the attachment and restart the transition.
 */
export function attachDotField<Seed, State extends string>(
	root: HTMLElement,
	canvas: HTMLCanvasElement,
	accentSwatch: HTMLElement,
	options: DotFieldOptions<Seed, State>
): () => void {
	const context = canvas.getContext('2d');
	if (!context) return () => {};
	const ctx: CanvasRenderingContext2D = context;
	const { geometry, size, radius, readState, transitionMs } = options;

	const seeds = geometry.layout(size);
	const fits = new Map<State, ShapeFit>();
	for (const state of geometry.states) fits.set(state, measureFit(geometry, seeds, state));

	const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let reducedMotion = motionQuery.matches;
	let visible = true;
	let frame = 0;
	let initialized = false;
	let targetState: State = geometry.states[0];
	let previousState: State = targetState;
	let transitionStarted = 0;
	let lastDpr = 0;
	let colorsReadAt = 0;
	let ink: Rgb = [128, 128, 128];
	let accent: Rgb = ink;
	let ground: Rgb = ink;
	let lastStaticState: State | null = null;
	// Each instance starts at its own point in the cycle, so a row of marks does not move in step.
	const phase = noise(size, 11) * 20;

	function seated(state: State, index: number, time: number): DotPoint {
		const point = geometry.point(state, seeds[index], index, time);
		const fit = fits.get(state) ?? { cx: 0, cy: 0, scale: 1 };
		point.x = (point.x - fit.cx) * fit.scale;
		point.y = (point.y - fit.cy) * fit.scale;
		return point;
	}

	function draw(now: number, staticFrame = false): void {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (dpr !== lastDpr) {
			canvas.width = Math.max(1, Math.round(size * dpr));
			canvas.height = Math.max(1, Math.round(size * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			lastDpr = dpr;
		}
		if (now - colorsReadAt > 800 || colorsReadAt === 0) {
			ink = rgb(getComputedStyle(canvas).color);
			accent = rgb(getComputedStyle(accentSwatch).color);
			ground = rgb(groundOf(root));
			colorsReadAt = now;
		}

		const currentState = readState(root);
		if (currentState !== targetState) {
			previousState = targetState;
			targetState = currentState;
			transitionStarted = now;
		}

		const progress = staticFrame ? 1 : clamp((now - transitionStarted) / transitionMs);
		const mixAmount = 1 - (1 - progress) ** 4;
		const ribbon = size < RIBBON_BELOW && geometry.faces !== undefined;
		// Quicker as a ribbon, as the reference presets are: a small mark has to move more to be
		// seen moving at all.
		const time = (staticFrame ? 2.25 : now / 1000 + phase) * (ribbon ? 1.5 : 1);
		const reach = size * radius;
		const compact = size <= 24;
		const near = dotNear(size);
		const far = dotFar(size);

		const points: Array<DotPoint & { index: number }> = [];
		for (let index = 0; index < seeds.length; index += 1) {
			const to = seated(targetState, index, time);
			if (mixAmount < 1) {
				const from = seated(previousState, index, time);
				to.x = from.x + (to.x - from.x) * mixAmount;
				to.y = from.y + (to.y - from.y) * mixAmount;
				to.z = from.z + (to.z - from.z) * mixAmount;
				to.light = from.light + (to.light - from.light) * mixAmount;
				to.accent = from.accent + (to.accent - from.accent) * mixAmount;
				to.boost = from.boost + (to.boost - from.boost) * mixAmount;
				to.vis = from.vis + (to.vis - from.vis) * mixAmount;
			}
			points.push({ ...to, index });
		}

		ctx.clearRect(0, 0, size, size);
		const half = size / 2;

		const surfaced = geometry.faces !== undefined && size < (geometry.surfaceBelow ?? RIBBON_BELOW);
		if (surfaced && geometry.faces) {
			// A faint surface under the dots, far to near, so the shape shows through the lattice
			// — at icon size, where the dots alone would read as a smudge, or at every size for a
			// mark that is a body rather than a diagram.
			const faces = geometry.faces(seeds, targetState).map(([a, b, c, d]) => {
				const quad = [points[a], points[b], points[c], points[d]] as const;
				return { quad, z: (quad[0].z + quad[1].z + quad[2].z + quad[3].z) / 4 };
			});
			faces.sort((p, q) => p.z - q.z);
			ctx.lineJoin = 'round';
			const px = (p: DotPoint) => half + p.x * reach;
			const py = (p: DotPoint) => half - p.y * reach;
			for (const { quad, z } of faces) {
				const [a, b, c, d] = quad;
				const vis = Math.min(a.vis, b.vis, c.vis, d.vis);
				if (vis <= 0.02) continue;
				const depth = clamp((z + 1) / 2);
				const light = (a.light + b.light + c.light + d.light) / 4;
				const fill = clamp((0.08 + 0.3 * depth) * (0.5 + 0.5 * light) * vis);
				// A solid face is a body's own colour, on any ground: the shadow is black. Every other
				// face is translucent ink, so a surface passing in front of the shadow glows across it
				// instead of wiping it out.
				const solid = quad.every((p) => p.solid);
				ctx.globalAlpha = solid ? 1 : fill;
				ctx.fillStyle = solid ? 'rgb(0,0,0)' : css(ink);
				// A hairline in the fill colour closes the seams between patches.
				ctx.strokeStyle = ctx.fillStyle;
				ctx.lineWidth = 0.5;
				ctx.beginPath();
				ctx.moveTo(px(a), py(a));
				ctx.lineTo(px(b), py(b));
				ctx.lineTo(px(c), py(c));
				ctx.lineTo(px(d), py(d));
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}

		// Over a ribbon the dots are smaller, fewer and higher in contrast: the shape is already
		// there underneath, so they only have to carry depth and motion.
		const dotFarPx = ribbon ? 0.3 : far;
		const dotNearPx = ribbon ? 0.7 : near;
		const floor = ribbon ? 0.1 : INK_FLOOR;
		points.sort((a, b) => a.z - b.z || a.index - b.index);
		for (const point of points) {
			if (point.vis <= 0.02 || point.solid) continue;
			const depth = clamp((point.z + 1) / 2);
			const dotRadius = dotFarPx + (dotNearPx - dotFarPx) * depth + (compact ? 0 : point.boost);
			// Far dots sit close to the ground, near dots are full ink; a surface seen edge-on is
			// dimmer than one facing the viewer.
			const strength = clamp((floor + (1 - floor) * depth) * (0.6 + 0.4 * point.light) * point.vis);
			const colour = point.accent > 0.02 ? mix(ink, accent, clamp(point.accent)) : ink;
			ctx.fillStyle = css(mix(ground, colour, strength));
			ctx.beginPath();
			ctx.arc(half + point.x * reach, half - point.y * reach, dotRadius, 0, TAU);
			ctx.fill();
		}
	}

	function tick(now: number): void {
		if (!initialized) {
			targetState = readState(root);
			previousState = targetState;
			transitionStarted = now;
			initialized = true;
		}
		if (reducedMotion) {
			const currentState = readState(root);
			if (currentState !== lastStaticState) {
				lastStaticState = currentState;
				draw(now, true);
			}
		} else {
			draw(now);
		}
		frame = requestAnimationFrame(tick);
	}

	function start(): void {
		if (frame || !visible || document.hidden) return;
		frame = requestAnimationFrame(tick);
	}

	function stop(): void {
		if (!frame) return;
		cancelAnimationFrame(frame);
		frame = 0;
	}

	function updateVisibility(): void {
		if (document.hidden || !visible) stop();
		else start();
	}

	function updateMotionPreference(): void {
		reducedMotion = motionQuery.matches;
		lastStaticState = null;
		updateVisibility();
	}

	const observer = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
		updateVisibility();
	});
	observer.observe(canvas);
	document.addEventListener('visibilitychange', updateVisibility);
	motionQuery.addEventListener('change', updateMotionPreference);
	start();

	return () => {
		stop();
		observer.disconnect();
		document.removeEventListener('visibilitychange', updateVisibility);
		motionQuery.removeEventListener('change', updateMotionPreference);
	};
}
