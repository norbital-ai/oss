<script lang="ts">
	import { onMount } from 'svelte';
	import type { AgentOrbState } from './agent-orb-state.js';

	type OrbPoint = {
		x: number;
		y: number;
		z: number;
		accent: number;
		boost: number;
		visibility: number;
	};
	type SphereSeed = { latitude: number; longitude: number };
	const constellationAnchors: ReadonlyArray<readonly [number, number]> = [
		[-0.74, 0.12],
		[-0.5, 0.23],
		[-0.26, 0.13],
		[-0.02, 0.01],
		[0.22, 0.24],
		[0.53, 0.13],
		[0.42, -0.24]
	];
	let {
		state = 'idle',
		size = 20,
		label,
		class: className = ''
	}: {
		state?: AgentOrbState;
		size?: number;
		label?: string;
		class?: string;
	} = $props();

	let canvas: HTMLCanvasElement;
	let accentSwatch: HTMLSpanElement;
	let redrawStatic = () => {};

	function clamp(value: number, min = 0, max = 1): number {
		return Math.min(max, Math.max(min, value));
	}

	function angleDistance(a: number, b: number): number {
		return Math.atan2(Math.sin(a - b), Math.cos(a - b));
	}

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

	function buildSphereLayout(renderSize: number): SphereSeed[] {
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

	function orientStateShape(
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

	function searchingSkyPoint(
		index: number,
		layout: SphereSeed[],
		time: number,
		orb: OrbPoint
	): OrbPoint {
		const seed = layout[index];
		const seedRadius = Math.sqrt(Math.max(0, 1 - seed.latitude * seed.latitude));
		const seedX = seedRadius * Math.cos(seed.longitude);
		const seedY = seed.latitude;
		const seedZ = seedRadius * Math.sin(seed.longitude);
		const guideIndex = (time * 0.82) % constellationAnchors.length;
		let constellationGlow = 0;

		for (let anchorIndex = 0; anchorIndex < constellationAnchors.length; anchorIndex += 1) {
			const anchor = constellationAnchors[anchorIndex];
			const targetX = anchor[0] * 0.88;
			const targetY = anchor[1] * 1.08;
			const targetZ = Math.sqrt(Math.max(0.08, 1 - targetX * targetX - targetY * targetY));
			const separation = Math.acos(
				clamp(seedX * targetX + seedY * targetY + seedZ * targetZ, -1, 1)
			);
			const proximity = Math.exp(-(separation * separation) / 0.014);
			const orderDistance = Math.min(
				Math.abs(anchorIndex - guideIndex),
				constellationAnchors.length - Math.abs(anchorIndex - guideIndex)
			);
			const guide = Math.exp(-(orderDistance * orderDistance) / 0.32);
			constellationGlow = Math.max(constellationGlow, proximity * (0.58 + guide * 0.42));
		}

		const twinkle = 0.5 + Math.sin(index * 2.17 + time * 1.1) * 0.5;
		return {
			...orb,
			accent: Math.max(orb.accent * 0.06, constellationGlow),
			boost: orb.boost * 0.06 + constellationGlow * 0.24,
			visibility: 0.76 + twinkle * 0.24
		};
	}

	function stateShapePoint(
		mode: AgentOrbState,
		index: number,
		count: number,
		time: number
	): OrbPoint {
		const dotCount = Math.min(
			count,
			mode === 'authoring'
				? Math.max(48, Math.round(Math.sqrt(count) * 7.2))
				: Math.max(18, Math.round(Math.sqrt(count) * 3.4))
		);
		const dotRank = Math.round((index * (dotCount - 1)) / Math.max(1, count - 1));
		const activeIndex = Math.round((dotRank * (count - 1)) / Math.max(1, dotCount - 1));
		const visibility = index === activeIndex ? 1 : 0;
		const depthPhase = dotRank * 2.399963;
		if (mode === 'authoring') {
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

	function stateShapeMix(mode: AgentOrbState, time: number): number {
		if (mode === 'idle' || mode === 'thinking') return 0;
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

	function spherePoint(
		mode: AgentOrbState,
		index: number,
		layout: SphereSeed[],
		time: number,
		compact: boolean
	): OrbPoint {
		const seed = layout[index];
		const baseLatitude = seed.latitude;
		const drift = Math.sin(time * 0.68 + index * 0.31) * 0.018;
		const longitude = seed.longitude + time * 0.22 + drift;
		const latitudeWave =
			mode === 'thinking'
				? Math.sin(longitude * 2.25 - time * 2.4) * (1 - baseLatitude * baseLatitude) * 0.052
				: 0;
		const latitude = clamp(baseLatitude + latitudeWave, -0.98, 0.98);
		const ringRadius = Math.sqrt(Math.max(0, 1 - latitude * latitude));
		const thinkingWave =
			0.58 * Math.sin(latitude * 8.2 - time * 2.35) +
			0.42 * Math.sin(longitude * 3 + latitude * 2.4 - time * 1.45);
		const baseRipple = 0.012 * Math.sin(longitude * 3 - time * 0.8);
		const stateRipple =
			mode === 'thinking' ? thinkingWave * 0.052 : mode === 'working' ? thinkingWave * 0.018 : 0;
		const pulse = 1 + baseRipple + stateRipple;
		const tilt = 0.38 + Math.sin(time * 0.42) * 0.045;
		const sphereX = ringRadius * Math.cos(longitude);
		const sphereZ = ringRadius * Math.sin(longitude);
		const point = rotatePoint(sphereX * pulse, latitude * pulse, sphereZ * pulse, 0, tilt);

		if (mode === 'searching') {
			const pingCycle = 2.05;
			const pingProgress = (time % pingCycle) / pingCycle;
			const originLatitude = 0.18 + Math.sin(time * 0.18) * 0.08;
			const originLongitude = time * 0.16;
			const originRadius = Math.sqrt(1 - originLatitude * originLatitude);
			const dot =
				sphereX * originRadius * Math.cos(originLongitude) +
				latitude * originLatitude +
				sphereZ * originRadius * Math.sin(originLongitude);
			const surfaceDistance = Math.acos(clamp(dot, -1, 1));
			const pingRadius = 0.12 + pingProgress * 2.5;
			const ringWidth = compact ? 0.042 : 0.022;
			const envelope = Math.sin(Math.PI * pingProgress) ** 0.48;
			const ping = Math.exp(-((surfaceDistance - pingRadius) ** 2) / ringWidth) * envelope;
			const source =
				Math.exp(-(surfaceDistance * surfaceDistance) / 0.035) * (1 - pingProgress) ** 2;
			const depthVisibility = 0.22 + clamp(point.z * 1.65) * 0.78;
			point.accent = Math.max(ping, source) * depthVisibility;
			point.boost = point.accent * 0.42;
		} else if (mode === 'thinking') {
			const crest = clamp((thinkingWave - 0.04) / 0.82);
			point.accent = crest * clamp(point.z * 1.45) * 0.72;
			point.boost = crest * 0.12;
		} else if (mode === 'authoring') {
			const writingFlow = Math.sin(longitude + latitude * 3.6 - time * 1.65);
			const band = Math.exp(-(writingFlow * writingFlow) / 0.055);
			point.accent = band * clamp(point.z * 1.5) * 0.82;
			point.boost = point.accent * 0.1;
		} else if (mode === 'working') {
			const currentA = angleDistance(longitude, time * 1.55 + latitude * 2.4);
			const currentB = angleDistance(longitude, -time * 1.15 - latitude * 2.8 + Math.PI);
			const current = Math.max(
				Math.exp(-(currentA * currentA) / 0.1),
				Math.exp(-(currentB * currentB) / 0.12) * 0.72
			);
			point.accent = current * clamp(point.z * 1.55);
			point.boost = point.accent * 0.16;
		} else {
			const emberDistance = angleDistance(longitude, time * 0.52 + latitude * 2);
			point.accent = Math.exp(-(emberDistance * emberDistance) / 0.08) * clamp(point.z) * 0.16;
		}

		return point;
	}

	function pointForState(
		mode: AgentOrbState,
		index: number,
		layout: SphereSeed[],
		time: number,
		compact: boolean,
		phaseTime = time
	): OrbPoint {
		const orb = spherePoint(mode, index, layout, time, compact);
		const shapeMix = stateShapeMix(mode, phaseTime);
		if (shapeMix === 0) return orb;
		const shape =
			mode === 'searching'
				? searchingSkyPoint(index, layout, time, orb)
				: stateShapePoint(mode, index, layout.length, time);
		return interpolatePoint(orb, shape, shapeMix);
	}

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

	$effect(() => {
		state;
		size;
		redrawStatic();
	});

	onMount(() => {
		const canvasContext = canvas.getContext('2d');
		if (!canvasContext) return;
		const context: CanvasRenderingContext2D = canvasContext;

		const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		let reducedMotion = motionQuery.matches;
		let visible = true;
		let frame = 0;
		let targetState = state;
		let previousState = state;
		let transitionStarted = performance.now();
		let inkColor = getComputedStyle(canvas).color;
		let accentColor = getComputedStyle(accentSwatch).color;
		let lastColorRead = 0;
		let lastCanvasSize = 0;
		let lastDpr = 0;
		let sphereLayout: SphereSeed[] = [];

		function syncCanvas(): number {
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			if (lastCanvasSize !== size || lastDpr !== dpr) {
				if (lastCanvasSize !== size) sphereLayout = buildSphereLayout(size);
				canvas.width = Math.max(1, Math.round(size * dpr));
				canvas.height = Math.max(1, Math.round(size * dpr));
				context.setTransform(dpr, 0, 0, dpr, 0, 0);
				lastCanvasSize = size;
				lastDpr = dpr;
			}
			return dpr;
		}

		function draw(now: number, staticFrame = false): void {
			syncCanvas();
			if (now - lastColorRead > 800 || lastColorRead === 0) {
				inkColor = getComputedStyle(canvas).color;
				accentColor = getComputedStyle(accentSwatch).color;
				lastColorRead = now;
			}

			if (state !== targetState) {
				previousState = targetState;
				targetState = state;
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
			const radius = size * 0.405;
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

		function tick(now: number): void {
			draw(now);
			frame = requestAnimationFrame(tick);
		}

		function start(): void {
			if (frame || reducedMotion || !visible || document.hidden) return;
			frame = requestAnimationFrame(tick);
		}

		function stop(): void {
			if (!frame) return;
			cancelAnimationFrame(frame);
			frame = 0;
		}

		function updateMotionPreference(): void {
			reducedMotion = motionQuery.matches;
			if (reducedMotion) {
				stop();
				draw(performance.now(), true);
			} else {
				start();
			}
		}

		function updateVisibility(): void {
			if (document.hidden || !visible) stop();
			else if (reducedMotion) draw(performance.now(), true);
			else start();
		}

		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? true;
			updateVisibility();
		});
		observer.observe(canvas);
		document.addEventListener('visibilitychange', updateVisibility);
		motionQuery.addEventListener('change', updateMotionPreference);

		redrawStatic = () => {
			if (reducedMotion) draw(performance.now(), true);
		};
		if (reducedMotion) draw(performance.now(), true);
		else start();

		return () => {
			stop();
			observer.disconnect();
			document.removeEventListener('visibilitychange', updateVisibility);
			motionQuery.removeEventListener('change', updateMotionPreference);
			redrawStatic = () => {};
		};
	});
</script>

<span
	class={`norbital-thinking-orb ${className}`}
	data-state={state}
	data-compact={size <= 36 ? 'true' : undefined}
	style={`--orb-size: ${size}px`}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<canvas bind:this={canvas} aria-hidden="true"></canvas>
	<span bind:this={accentSwatch} class="orb-accent-swatch" aria-hidden="true"></span>
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
