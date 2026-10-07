<!--
	`NorbiusField`: the access pages' backdrop (Bolt's sign-in and a host's workspace picker), the Norbius band at page scale. The agent mark's own Möbius band
	(`norbiusStripGeometry`, ready) in the mark's own dot vocabulary — round, opaque-looking dots on an open lattice, near ones larger and full ink, far ones
	small and faint, z-sorted — just bigger and denser. Its own canvas runner: the icon's runner caps dots at ~1.2 px for a 24–96 px box.
	Pauses in a hidden tab; one still frame under reduced motion.
-->
<svelte:options runes />

<script lang="ts" module>
	import { measureFit } from './dot-field.js';
	import { norbiusStripGeometry } from './norbius-geometry.js';

	const TAU = Math.PI * 2;
	/** Lattice: rings around the band × dots across it, alternate columns offset half a ring like the mark's. ponytail: fixed ≈2k dots, re-sorted per frame. */
	const AROUND = 150, ACROSS = 13;
	/** Dot radius in CSS px at the back and front, and the ink a far dot keeps. */
	const FAR = 1.1, NEAR = 2.8, INK_FLOOR = 0.18;

	const LATTICE = Array.from({ length: AROUND * ACROSS }, (_, i) => {
		const ring = Math.floor(i / ACROSS), column = i % ACROSS;
		const v = (column / (ACROSS - 1)) * 2 - 1;
		return { u: ((ring + (column % 2) / 2) / AROUND) * TAU, v, edge: Math.abs(v) === 1, wide: 1, lift: 0 };
	});
	/** Seated once over a whole cycle, as the mark is: a per-frame fit would make the band breathe. */
	const FIT = measureFit(norbiusStripGeometry, LATTICE, 'ready');

	/** Any CSS colour → [r, g, b], through a 1×1 canvas (computed colours may be oklch()). */
	function rgb(color: string): [number, number, number] {
		const probe = document.createElement('canvas');
		probe.width = probe.height = 1;
		const c = probe.getContext('2d')!;
		c.fillStyle = color;
		c.fillRect(0, 0, 1, 1);
		const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
		return [r!, g!, b!];
	}

	function band(canvas: HTMLCanvasElement, inkSwatch: HTMLElement, brandSwatch: HTMLElement, groundSwatch: HTMLElement): () => void {
		const context = canvas.getContext('2d');
		if (context === null) return () => {};
		const ctx = context;
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		let width = 0, height = 0, dpr = 1, frame = 0, last = 0, time = 3;
		let ink: number[] = [], brand: number[] = [], ground: number[] = [], themeKey = '';
		const xs = new Float32Array(LATTICE.length), ys = new Float32Array(LATTICE.length), zs = new Float32Array(LATTICE.length);
		const lit = new Float32Array(LATTICE.length), heat = new Float32Array(LATTICE.length);
		const order = Array.from(LATTICE, (_, i) => i);

		function resize(): void {
			dpr = Math.min(2, window.devicePixelRatio || 1);
			width = window.innerWidth;
			height = window.innerHeight;
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}

		function draw(): void {
			if (canvas.getClientRects().length === 0) return;
			const dark = document.documentElement.classList.contains('dark');
			const key = [inkSwatch, brandSwatch, groundSwatch].map((e) => getComputedStyle(e).color).join();
			if (key !== themeKey) { themeKey = key; [ink, brand, ground] = [inkSwatch, brandSwatch, groundSwatch].map((e) => rgb(getComputedStyle(e).color)); }

			// the agent mark's own band, seated like the mark and grown to page scale
			const reach = Math.min(width * 0.46, height * 0.45);
			for (let i = 0; i < LATTICE.length; i++) {
				const p = norbiusStripGeometry.point('ready', LATTICE[i]!, i, time);
				xs[i] = width / 2 + (p.x - FIT.cx) * FIT.scale * reach;
				ys[i] = height / 2 - (p.y - FIT.cy) * FIT.scale * reach;
				zs[i] = p.z;
				lit[i] = p.light;
				heat[i] = Math.min(1, p.accent);
				order[i] = i;
			}
			order.sort((a, b) => zs[a]! - zs[b]!);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			// a backdrop, not the mark: the whole field sits at a share of full ink
			const share = dark ? 0.55 : 0.5;
			for (const i of order) {
				const depth = Math.min(1, Math.max(0, (zs[i]! + 1) / 2));
				const h = heat[i]!;
				const strength = share * Math.min(1, (INK_FLOOR + (1 - INK_FLOOR) * depth) * (0.6 + 0.4 * lit[i]!) + h * 0.4);
				ctx.fillStyle = `rgb(${ground.map((g, j) => Math.round(g + (ink[j]! + (brand[j]! - ink[j]!) * h - g) * strength)).join(' ')})`;
				ctx.beginPath();
				ctx.arc(xs[i]!, ys[i]!, FAR + (NEAR - FAR) * depth, 0, TAU);
				ctx.fill();
			}
		}

		function tick(now: number): void {
			time += Math.min(64, now - (last || now)) / 1000;
			last = now;
			draw();
			frame = requestAnimationFrame(tick);
		}
		function start(): void {
			if (still || frame !== 0 || document.hidden) return;
			last = 0;
			frame = requestAnimationFrame(tick);
		}
		function stop(): void {
			cancelAnimationFrame(frame);
			frame = 0;
		}
		const visibility = () => (document.hidden ? stop() : start());
		const onResize = () => { resize(); draw(); };

		resize();
		draw();
		start();
		window.addEventListener('resize', onResize);
		document.addEventListener('visibilitychange', visibility);
		return () => {
			stop();
			window.removeEventListener('resize', onResize);
			document.removeEventListener('visibilitychange', visibility);
		};
	}
</script>

<span class="particle-field" aria-hidden="true"
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const [ink, brand, ground] = root.querySelectorAll<HTMLElement>('[data-swatch]');
		if (!(canvas instanceof HTMLCanvasElement) || ink === undefined || brand === undefined || ground === undefined) return;
		return band(canvas, ink, brand, ground);
	}}>
	<canvas></canvas>
	<span data-swatch class="text-foreground"></span>
	<span data-swatch class="text-brand dark:text-brand-400"></span>
	<span data-swatch class="text-background"></span>
</span>

<style>
	.particle-field {
		position: fixed;
		inset: 0;
		pointer-events: none;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	[data-swatch] {
		position: absolute;
		width: 0;
		height: 0;
		visibility: hidden;
	}
</style>
