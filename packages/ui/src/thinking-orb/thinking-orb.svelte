<script lang="ts">
	import { ThinkingOrbStateSchema, type ThinkingOrbState } from '#lib/thinking-orb';
	import { Number as Number_, Schema } from 'effect';

	type OrbPoint = {
		x: number;
		y: number;
		z: number;
		accent: number;
		boost: number;
		visibility: number;
	};
	type SphereSeed = { latitude: number; longitude: number };
	/** Where a shape sits in the unit box and what it takes to seat it there. */
	type ShapeFit = { centreX: number; centreY: number; scale: number };
	/** One fit per state, since the burst an `error` throws reaches further than a turning sphere. */
	type ShapeFits = Record<ThinkingOrbState, ShapeFit>;
	let {
		state = 'ready',
		size = 20,
		label,
		class: className = ''
	}: {
		state?: ThinkingOrbState;
		size?: number;
		label?: string;
		class?: string;
	} = $props();

	/** The drawn mark's radius as a fraction of the box. See the note at its use. */
	const ORB_OPTICAL_RADIUS = 0.33;

	/**
	 * How long, and how finely, a shape is sampled to find its own extent.
	 *
	 * Long enough to cover the slowest motion the sphere has — its 0.42 rad/s tilt and the error
	 * burst's own loop both close well inside it. The step is coarse because the extremes move
	 * smoothly: a finer one shifts the measured reach by well under a tenth of a device pixel.
	 */
	const FIT_SAMPLE_SECONDS = 12;
	const FIT_SAMPLE_STEP = 0.25;

	/** Read the live attribute Svelte keeps in sync — the attach closure must not snapshot `state`. */
	function liveOrbState(root: Element): ThinkingOrbState {
		// stupidity:allow Q4 -- named helper
		const value = root.getAttribute('data-state');
		return value !== null && Schema.is(ThinkingOrbStateSchema)(value) ? value : 'ready';
	}

	/** Clamps a numeric value to the inclusive range between min and max. */
	function clamp(value: number, min = 0, max = 1): number {
		return Number_.clamp(value, { minimum: min, maximum: max });
	}

	/** Returns the shortest signed angular distance between two radians. */
	function angleDistance(a: number, b: number): number {
		// stupidity:allow Q4 -- named helper
		return Math.atan2(Math.sin(a - b), Math.cos(a - b));
	}

	/** Applies yaw and tilt rotations to a 3D point for sphere rendering. */
	function rotatePoint(x: number, y: number, z: number, yaw: number, tilt: number): OrbPoint {
		const sy = Math.sin(yaw);
		const cy = Math.cos(yaw);
		const st = Math.sin(tilt);
		const ct = Math.cos(tilt);
		const x1 = x * cy + z * sy;
		const z1 = -x * sy + z * cy;
		return {
			x: x1,
			y: y * ct - z1 * st,
			z: y * st + z1 * ct,
			accent: 0,
			boost: 0,
			visibility: 1
		};
	}

	/** Builds sphere seed coordinates scaled to the render size. */
	function buildSphereLayout(renderSize: number): SphereSeed[] {
		// stupidity:allow Q3 -- named helper
		const sizeRatio = renderSize / 64;
		const ringScale = clamp(Math.pow(sizeRatio, 0.35), 0.68, 1);
		const columnScale = clamp(Math.pow(sizeRatio, 0.45), 0.56, 1);
		const rings = Math.max(7, Math.round(13 * ringScale));
		const equatorColumns = Math.max(11, Math.round(22 * columnScale));
		const layout: SphereSeed[] = [];

		for (let ring = 0; ring < rings; ring += 1) {
			const polarAngle = (ring / (rings - 1)) * Math.PI;
			const latitude = Math.cos(polarAngle);
			const ringRadius = Math.sin(polarAngle);
			const columns =
				ring === 0 || ring === rings - 1 ? 1 : Math.max(4, Math.round(equatorColumns * ringRadius));
			const ringOffset = (ring % 2) * (Math.PI / columns) + ring * 0.071;
			for (let column = 0; column < columns; column += 1) {
				layout.push({
					latitude,
					longitude: (column / columns) * Math.PI * 2 + ringOffset
				});
			}
		}

		return layout;
	}

	/** Positions and styles a sphere particle for the given agent orb state. */
	function spherePoint( // stupidity:allow Q3 -- named helper
		mode: ThinkingOrbState,
		index: number,
		layout: SphereSeed[],
		time: number
	): OrbPoint {
		const seed = layout[index];
		const baseLatitude = seed.latitude;
		const drift = Math.sin(time * 0.68 + index * 0.31) * 0.018;
		// Faster than the old 0.22: the orb reads as alive at a glance rather than only on a stare.
		const longitude = seed.longitude + time * 0.34 + drift;
		const latitudeWave = 0;
		const latitude = clamp(baseLatitude + latitudeWave, -0.98, 0.98);
		const ringRadius = Math.sqrt(Math.max(0, 1 - latitude * latitude));
		const thinkingWave =
			0.58 * Math.sin(latitude * 8.2 - time * 2.35) +
			0.42 * Math.sin(longitude * 3 + latitude * 2.4 - time * 1.45);
		const baseRipple = 0.012 * Math.sin(longitude * 3 - time * 0.8);
		const stateRipple = mode === 'working' ? thinkingWave * 0.018 : 0;
		const pulse = 1 + baseRipple + stateRipple;
		const tilt = 0.38 + Math.sin(time * 0.42) * 0.045;
		const sphereX = ringRadius * Math.cos(longitude);
		const sphereZ = ringRadius * Math.sin(longitude);
		const point = rotatePoint(sphereX * pulse, latitude * pulse, sphereZ * pulse, 0, tilt);

		if (mode === 'working') {
			const currentA = angleDistance(longitude, time * 1.55 + latitude * 2.4);
			const currentB = angleDistance(longitude, -time * 1.15 - latitude * 2.8 + Math.PI);
			const current = Math.max(
				Math.exp(-(currentA * currentA) / 0.1),
				Math.exp(-(currentB * currentB) / 0.12) * 0.72
			);
			point.accent = current * clamp(point.z * 1.55);
			point.boost = point.accent * 0.16;
		} else if (mode === 'error') {
			/**
			 * Comes apart and back together, rather than melting away.
			 *
			 * A failure that dissolves reads as the orb dying; the agent has not died, one turn did. The
			 * particles blow outward along their own radius and are pulled back on a loop, so the shape
			 * is legible as broken and as recoverable at the same time.
			 */
			const burst = (time * 0.85 + index * 0.0007) % 1;
			const scatter = Math.sin(Math.PI * burst) ** 1.6;
			const jitter = Math.sin(index * 12.9898 + time * 0.4) * 0.5;
			const spread = 1 + scatter * (0.55 + jitter * 0.35);
			point.x *= spread;
			point.y *= spread;
			point.z *= spread;
			point.accent = 1;
			point.boost = 0.1 + scatter * 0.24;
			point.visibility = 0.45 + (1 - scatter) * 0.55;
		} else {
			// Ready: a sweep of brand light travelling round the sphere, quick enough to read as idling
			// rather than stalled.
			const emberDistance = angleDistance(longitude, time * 1.05 + latitude * 2);
			const sweep = Math.exp(-(emberDistance * emberDistance) / 0.09);
			point.accent = sweep * clamp(point.z * 1.35) * 0.62;
			point.boost = point.accent * 0.12;
		}

		return point;
	}

	/**
	 * Measures one shape over a whole cycle of its own motion: where it sits, and how far it reaches.
	 *
	 * Sampled once per size rather than per frame on purpose. A per-frame fit would rescale the mark
	 * as it turned, and the orb would breathe against the icons beside it.
	 */
	function measureFit(project: (time: number, index: number) => OrbPoint, count: number): ShapeFit {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (let time = 0; time < FIT_SAMPLE_SECONDS; time += FIT_SAMPLE_STEP) {
			for (let index = 0; index < count; index += 1) {
				const point = project(time, index);
				// A particle the shape hides says nothing about where the shape reaches.
				if (point.visibility <= 0) continue;
				minX = Math.min(minX, point.x);
				maxX = Math.max(maxX, point.x);
				minY = Math.min(minY, point.y);
				maxY = Math.max(maxY, point.y);
			}
		}
		// One scale for both axes: fitting each separately would squash the sphere into an ellipse.
		const reach = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
		return {
			centreX: (minX + maxX) / 2,
			centreY: (minY + maxY) / 2,
			scale: reach > 0 && Number.isFinite(reach) ? 1 / reach : 1
		};
	}

	/** Measures the sphere in each state it can be drawn in, for one layout. */
	function buildShapeFits(layout: SphereSeed[]): ShapeFits {
		const count = layout.length;
		const fit = (mode: ThinkingOrbState): ShapeFit =>
			measureFit((time, index) => spherePoint(mode, index, layout, time), count);
		return { ready: fit('ready'), working: fit('working'), error: fit('error') };
	}

	/** Seats a shape's point in the unit box: centred, and reaching exactly to the edge. */
	function fitPoint(point: OrbPoint, fit: ShapeFit): OrbPoint {
		// `z` is depth shading, not position, so it is left as the shape drew it.
		point.x = (point.x - fit.centreX) * fit.scale;
		point.y = (point.y - fit.centreY) * fit.scale;
		return point;
	}

	/**
	 * Places one particle for a state, seated in the box.
	 *
	 * Seating is what keeps the mark still. Each state's sphere carries a different extent of its own
	 * — `error` throws its dots to 1.7x, which reached past the box, where `contain: paint` cut them
	 * off — so drawn raw the mark changed size and place as the agent's state changed. Seated, every
	 * state draws one mark, in one position, at one size.
	 */
	function pointForState(
		mode: ThinkingOrbState,
		index: number,
		layout: SphereSeed[],
		time: number,
		fits: ShapeFits
	): OrbPoint {
		return fitPoint(spherePoint(mode, index, layout, time), fits[mode]);
	}

	/** Linearly interpolates every field between two orb particle snapshots. */
	function interpolatePoint(from: OrbPoint, to: OrbPoint, amount: number): OrbPoint {
		return {
			x: from.x + (to.x - from.x) * amount,
			y: from.y + (to.y - from.y) * amount,
			z: from.z + (to.z - from.z) * amount,
			accent: from.accent + (to.accent - from.accent) * amount,
			boost: from.boost + (to.boost - from.boost) * amount,
			visibility: from.visibility + (to.visibility - from.visibility) * amount
		};
	}
</script>

<span
	class={`norbital-thinking-orb ${className}`}
	data-state={state}
	data-compact={size <= 36 ? 'true' : undefined}
	style={`--orb-size: ${size}px`}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const accentSwatch = root.querySelector('.orb-accent-swatch');
		if (!(canvas instanceof HTMLCanvasElement) || !(accentSwatch instanceof HTMLElement)) return;
		const canvasElement = canvas;
		const accentElement = accentSwatch;

		const canvasContext = canvasElement.getContext('2d');
		if (!canvasContext) return;
		const context: CanvasRenderingContext2D = canvasContext;

		const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		let reducedMotion = motionQuery.matches;
		let visible = true;
		let frame = 0;
		let targetState: ThinkingOrbState = 'ready';
		let previousState: ThinkingOrbState = 'ready';
		let transitionStarted = performance.now();
		let initialized = false;
		let inkColor = getComputedStyle(canvasElement).color;
		let accentColor = getComputedStyle(accentElement).color;
		let lastColorRead = 0;
		let lastCanvasSize = 0;
		let lastDpr = 0;
		let sphereLayout: SphereSeed[] = [];
		let shapeFits: ShapeFits | undefined;
		let lastDrawnState: ThinkingOrbState | null = null;
		let lastDrawnSize = 0;

		/** Resizes the canvas and rebuilds sphere layout when size or DPR changes. */
		function syncCanvas(): number {
			// stupidity:allow Q3 -- named helper
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			if (lastCanvasSize !== size || lastDpr !== dpr) {
				if (lastCanvasSize !== size || shapeFits === undefined) {
					sphereLayout = buildSphereLayout(size);
					shapeFits = buildShapeFits(sphereLayout);
				}
				canvasElement.width = Math.max(1, Math.round(size * dpr));
				canvasElement.height = Math.max(1, Math.round(size * dpr));
				context.setTransform(dpr, 0, 0, dpr, 0, 0);
				lastCanvasSize = size;
				lastDpr = dpr;
			}
			return dpr;
		}

		/** Renders one orb frame with state transition blending and accent highlights. */
		function draw(now: number, staticFrame = false): void {
			syncCanvas();
			if (now - lastColorRead > 800 || lastColorRead === 0) {
				inkColor = getComputedStyle(canvasElement).color;
				accentColor = getComputedStyle(accentElement).color;
				lastColorRead = now;
			}

			const currentState = liveOrbState(root);
			if (currentState !== targetState) {
				previousState = targetState;
				targetState = currentState;
				transitionStarted = now;
			}

			const compact = size <= 36;
			const layout = sphereLayout;
			const fits = shapeFits;
			if (fits === undefined) return;
			const count = layout.length;
			const transitionDuration = compact ? 145 : 190;
			const transitionProgress = staticFrame
				? 1
				: clamp((now - transitionStarted) / transitionDuration);
			const mix = 1 - (1 - transitionProgress) ** 4;
			const elapsed = staticFrame ? 2.25 : now / 1000;
			/**
			 * The mark sits inside its box the way a stroke icon does, not filling it.
			 *
			 * Every shape is seated in the unit box before it gets here, so this radius is the whole of
			 * the mark's size in every state: the dots reach `radius` plus their own, and no further.
			 *
			 * A Lucide glyph draws roughly 20 of its 24 units, so at the identical 16px box every caller
			 * passes, matching that arithmetic would leave the orb reading as the larger mark: a disc of
			 * dots carries far more visual mass than an outline of the same diameter. At `0.33` the mark
			 * draws to about 73% of the box, which is where it reads as the same size as the icons above
			 * and below it.
			 *
			 * Applied here rather than by shrinking `size` at the call sites: the box is the layout
			 * contract every caller shares with `size-4`, and it is the drawing inside it that was wrong.
			 */
			const radius = size * ORB_OPTICAL_RADIUS;
			const dotScale = Math.pow(size / 64, 0.68) * (compact ? 1.06 : 1);
			const points: Array<OrbPoint & { index: number }> = [];

			for (let index = 0; index < count; index += 1) {
				const from = pointForState(previousState, index, layout, elapsed, fits);
				const to = pointForState(targetState, index, layout, elapsed, fits);
				points.push({ ...interpolatePoint(from, to, mix), index });
			}
			points.sort((a, b) => a.z - b.z || a.index - b.index);

			context.clearRect(0, 0, size, size);
			for (const point of points) {
				const depth = clamp((point.z + 1.08) / 2.16);
				const near = depth ** 1.45;
				const dotRadius = (0.26 + near * 1.08 + point.boost) * dotScale;
				const alpha = 0.16 + near * 0.82;
				const x = size / 2 + point.x * radius;
				const y = size / 2 - point.y * radius;

				context.globalAlpha = alpha * point.visibility * (1 - point.accent * 0.36);
				context.fillStyle = inkColor;
				context.beginPath();
				context.arc(x, y, dotRadius, 0, Math.PI * 2);
				context.fill();

				if (point.accent > 0.035) {
					context.globalAlpha = alpha * point.visibility * point.accent * 0.9;
					context.fillStyle = accentColor;
					context.beginPath();
					context.arc(x, y, dotRadius * (1 + point.accent * 0.08), 0, Math.PI * 2);
					context.fill();
				}
			}
			context.globalAlpha = 1;
		}

		/** Advances the animation loop, honoring reduced-motion and visibility pauses. */
		function tick(now: number): void {
			if (!initialized) {
				targetState = liveOrbState(root);
				previousState = targetState;
				transitionStarted = now;
				initialized = true;
			}
			if (reducedMotion) {
				const currentState = liveOrbState(root);
				if (currentState === lastDrawnState && size === lastDrawnSize) {
					frame = requestAnimationFrame(tick);
					return;
				}
				lastDrawnState = currentState;
				lastDrawnSize = size;
				draw(now, true);
			} else {
				draw(now);
			}
			frame = requestAnimationFrame(tick);
		}

		/** Starts the requestAnimationFrame loop when the orb is visible. */
		function start(): void {
			// stupidity:allow Q4 -- named helper
			if (frame || !visible || document.hidden) return;
			frame = requestAnimationFrame(tick);
		}

		/** Cancels the active animation frame, if any. */
		function stop(): void {
			if (!frame) return;
			cancelAnimationFrame(frame);
			frame = 0;
		}

		/** Reacts to prefers-reduced-motion changes and redraws a static frame. */
		function updateMotionPreference(): void {
			reducedMotion = motionQuery.matches;
			lastDrawnState = null;
			lastDrawnSize = 0;
			if (reducedMotion) draw(performance.now(), true);
			updateVisibility();
		}

		/** Starts or stops animation based on document and intersection visibility. */
		function updateVisibility(): void {
			// stupidity:allow Q4 -- named helper
			if (document.hidden || !visible) stop();
			else start();
		}

		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? true;
			updateVisibility();
		});
		observer.observe(canvasElement);
		document.addEventListener('visibilitychange', updateVisibility);
		motionQuery.addEventListener('change', updateMotionPreference);

		start();

		return () => {
			stop();
			observer.disconnect();
			document.removeEventListener('visibilitychange', updateVisibility);
			motionQuery.removeEventListener('change', updateMotionPreference);
		};
	}}
>
	<canvas aria-hidden="true"></canvas>
	<span class="orb-accent-swatch" aria-hidden="true"></span>
</span>

<style>
	.norbital-thinking-orb {
		--orb-accent: var(--product-icon-accent, var(--color-brand));
		position: relative;
		display: inline-grid;
		width: var(--orb-size);
		height: var(--orb-size);
		flex: none;
		place-items: center;
		color: currentColor;
		contain: strict;
	}

	.norbital-thinking-orb[data-state='failed'] {
		color: var(--color-destructive);
		--orb-accent: var(--color-destructive);
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	.orb-accent-swatch {
		position: absolute;
		width: 0;
		height: 0;
		color: var(--orb-accent);
		visibility: hidden;
	}

	@media (prefers-reduced-motion: reduce) {
		canvas {
			animation: none;
		}
	}
</style>
