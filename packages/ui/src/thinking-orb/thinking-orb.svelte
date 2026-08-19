<script lang="ts">
	import type { ThinkingOrbState } from './types.js';

	type OrbPoint = {
		x: number;
		y: number;
		z: number;
		accent: number;
		boost: number;
		visibility: number;
	};
	type SphereSeed = { latitude: number; longitude: number };
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

	const ORB_STATES: readonly ThinkingOrbState[] = ['ready', 'working', 'error'];

	/** The sphere's radius as a fraction of the box. See the note at its use for why it is not 0.405. */
	const ORB_OPTICAL_RADIUS = 0.355;

	/** Read the live attribute Svelte keeps in sync — the attach closure must not snapshot `state`. */
	function liveOrbState(root: Element): ThinkingOrbState {
		// stupidity:allow Q4 -- named helper
		const value = root.getAttribute('data-state');
		return value !== null && ORB_STATES.includes(value as ThinkingOrbState)
			? (value as ThinkingOrbState)
			: 'ready';
	}

	/** Clamps a numeric value to the inclusive range between min and max. */
	function clamp(value: number, min = 0, max = 1): number {
		// stupidity:allow Q4 -- named helper
		return Math.min(max, Math.max(min, value));
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

	/** Rotates a state-shape point and attaches accent, boost, and visibility. */
	function orientStateShape( // stupidity:allow Q3 -- named helper
		x: number,
		y: number,
		z: number,
		accent: number,
		boost: number,
		visibility: number,
		time: number
	): OrbPoint {
		const point = rotatePoint(
			x,
			y,
			z,
			-0.3 + Math.sin(time * 0.36) * 0.055,
			0.2 + Math.sin(time * 0.28) * 0.04
		);
		point.accent = accent;
		point.boost = boost;
		point.visibility = visibility;
		return point;
	}

	/** Computes the 2D state glyph layout point for a sphere particle index. */
	function stateShapePoint( // stupidity:allow Q3 -- named helper
		mode: ThinkingOrbState,
		index: number,
		count: number,
		time: number
	): OrbPoint {
		const dotCount = Math.min(
			count,
			mode === 'working'
				? Math.max(48, Math.round(Math.sqrt(count) * 7.2))
				: Math.max(18, Math.round(Math.sqrt(count) * 3.4))
		);
		const dotRank = Math.round((index * (dotCount - 1)) / Math.max(1, count - 1));
		const activeIndex = Math.round((dotRank * (count - 1)) / Math.max(1, dotCount - 1));
		const visibility = index === activeIndex ? 1 : 0;
		const depthPhase = dotRank * 2.399963;
		if (mode === 'working') {
			const railCount = Math.round(dotCount * 0.44);
			const isRail = dotRank < railCount;
			let u: number;
			let v: number;
			if (isRail) {
				const rail = dotRank % 2;
				const railPoints = Math.ceil(railCount / 2);
				u = (Math.floor(dotRank / 2) / railPoints) * Math.PI * 2;
				v = rail === 0 ? -0.5 : 0.5;
			} else {
				const ribRank = dotRank - railCount;
				const ribSteps = 6;
				const ribCount = Math.ceil((dotCount - railCount) / ribSteps);
				const rib = Math.floor(ribRank / ribSteps);
				v = (ribRank % ribSteps) / (ribSteps - 1) - 0.5;
				u = ((rib + 0.35) / ribCount) * Math.PI * 2 + v * 0.16;
			}
			const bandWidth = 0.8;
			const stripRadius = 0.5 + v * bandWidth * Math.cos(u / 2);
			const x = stripRadius * Math.cos(u);
			const y = stripRadius * Math.sin(u);
			const z = v * bandWidth * Math.sin(u / 2);
			const flowDistance = Math.abs(angleDistance(u, time * 1.18));
			const flow = Math.exp(-(flowDistance * flowDistance) / 0.46);
			const point = rotatePoint(x, y, z, time * 0.2, 0.66 + Math.sin(time * 0.24) * 0.05);
			point.x *= 1.14;
			point.y *= 0.98;
			point.accent = 0.1 + (isRail ? 0.08 : 0.03) + flow * 0.64;
			point.boost = 0.018 + (isRail ? 0.025 : 0) + flow * 0.08;
			point.visibility = visibility;
			return point;
		}

		const progress = dotRank / Math.max(1, dotCount - 1);
		const angle = progress * Math.PI * 2 + time * 0.18;
		const tooth = clamp((Math.cos(angle * 8) - 0.08) / 0.92) ** 2;
		const radius = 0.53 + tooth * 0.25 + Math.cos(depthPhase) * 0.04;
		return orientStateShape(
			Math.cos(angle) * radius,
			Math.sin(angle) * radius,
			Math.sin(depthPhase) * 0.115,
			0.52 + tooth * 0.34,
			0.05,
			visibility,
			time
		);
	}

	/** Returns the 0–1 blend factor between sphere and state-shape modes over time. */
	function stateShapeMix(mode: ThinkingOrbState, time: number): number {
		// stupidity:allow Q3 -- named helper
		if (mode !== 'working') return 0;
		const cycle = time % 5.2;
		if (cycle < 0.8 || cycle > 4.8) return 0;
		if (cycle < 1.25) {
			const progress = (cycle - 0.8) / 0.45;
			return 1 - (1 - progress) ** 4;
		}
		if (cycle <= 4.3) return 1;
		const progress = (cycle - 4.3) / 0.5;
		return (1 - progress) ** 3;
	}

	/** Positions and styles a sphere particle for the given agent orb state. */
	function spherePoint( // stupidity:allow Q3 -- named helper
		mode: ThinkingOrbState,
		index: number,
		layout: SphereSeed[],
		time: number,
		compact: boolean
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

	/** Blends sphere and state-shape positions for one particle at the current phase. */
	function pointForState(
		mode: ThinkingOrbState,
		index: number,
		layout: SphereSeed[],
		time: number,
		compact: boolean,
		phaseTime = time
	): OrbPoint {
		const orb = spherePoint(mode, index, layout, time, compact);
		const shapeMix = stateShapeMix(mode, phaseTime);
		if (shapeMix === 0) return orb;
		// Only `working` mixes to a shape, so this is always the strip.
		const shape = stateShapePoint(mode, index, layout.length, time);
		return interpolatePoint(orb, shape, shapeMix);
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
		let lastDrawnState: ThinkingOrbState | null = null;
		let lastDrawnSize = 0;

		/** Resizes the canvas and rebuilds sphere layout when size or DPR changes. */
		function syncCanvas(): number {
			// stupidity:allow Q3 -- named helper
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			if (lastCanvasSize !== size || lastDpr !== dpr) {
				if (lastCanvasSize !== size) sphereLayout = buildSphereLayout(size);
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
			const count = layout.length;
			const transitionDuration = compact ? 145 : 190;
			const transitionProgress = staticFrame
				? 1
				: clamp((now - transitionStarted) / transitionDuration);
			const mix = 1 - (1 - transitionProgress) ** 4;
			const elapsed = staticFrame ? 2.25 : now / 1000;
			const stateElapsed = staticFrame ? 2.25 : Math.max(0, (now - transitionStarted) / 1000);
			/**
			 * The sphere sits inside its box the way a stroke icon does, not filling it.
			 *
			 * At `0.405` the dots reached about 88% of the box once their own radius is counted, while a
			 * Lucide glyph draws roughly 20 of its 24 units — so beside one, at the identical 16px box
			 * every caller passes, the orb read as the larger mark and sat visibly proud of the row.
			 *
			 * The correction is more than the arithmetic difference, on purpose. A filled disc of dots
			 * carries far more visual mass than an outline of the same diameter, so matching the drawn
			 * extent alone would still look bigger; this lands the sphere near 78% of the box, which is
			 * where it reads as the same size as the icons above and below it.
			 *
			 * Applied here rather than by shrinking `size` at the call sites: the box is the layout
			 * contract every caller shares with `size-4`, and it is the drawing inside it that was wrong.
			 */
			const radius = size * ORB_OPTICAL_RADIUS;
			const dotScale = Math.pow(size / 64, 0.68) * (compact ? 1.06 : 1);
			const points: Array<OrbPoint & { index: number }> = [];

			for (let index = 0; index < count; index += 1) {
				const from = pointForState(previousState, index, layout, elapsed, compact);
				const to = pointForState(targetState, index, layout, elapsed, compact, stateElapsed);
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
