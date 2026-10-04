<!--
	`NorbiusField`: the access pages' backdrop (Bolt's sign-in and a host's workspace picker), the Norbius band at page scale. A Möbius strip drawn as a regular lattice of dots, slowly
	turning, lit by depth and facing like the icon; brand-coloured pulses leave one point at a fixed interval and travel
	around the band. Its own canvas runner: the icon's dot-field engine is tuned for a 24–96 px mark, not a full page.
	Pauses in a hidden tab; one still frame under reduced motion.
-->
<svelte:options runes />

<script lang="ts" module>
	const TAU = Math.PI * 2;
	/** Lattice: dots around the band × lines across it. ponytail: fixed ≈6.2k dots, depth-sorted per frame. */
	const AROUND = 240, ACROSS = 26;
	/** A pulse leaves every INTERVAL seconds and takes LAP seconds to go once around. */
	const INTERVAL = 2.4, LAP = 7.2, PULSE_WIDTH = 0.22;
	const LEVELS = 12;

	type Dot = { u: number; v: number };
	const LATTICE: readonly Dot[] = Array.from({ length: AROUND * ACROSS }, (_, i) => ({
		u: ((i % AROUND) / AROUND) * TAU,
		v: (Math.floor(i / AROUND) / (ACROSS - 1)) * 2 - 1,
	}));

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
	/** LEVELS fill styles from ink (0) to brand (LEVELS - 1). */
	function ramp(ink: string, brand: string): string[] {
		const a = rgb(ink), b = rgb(brand);
		return Array.from({ length: LEVELS }, (_, k) => {
			const t = k / (LEVELS - 1);
			return `rgb(${a.map((x, j) => Math.round(x + (b[j]! - x) * t)).join(' ')})`;
		});
	}

	function band(canvas: HTMLCanvasElement, inkSwatch: HTMLElement, brandSwatch: HTMLElement): () => void {
		const context = canvas.getContext('2d');
		if (context === null) return () => {};
		const ctx = context;
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		let width = 0, height = 0, dpr = 1, frame = 0, last = 0, time = 3;
		let styles: string[] = [], themeKey = '';
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
			const ink = getComputedStyle(inkSwatch).color, brand = getComputedStyle(brandSwatch).color;
			if (ink + brand !== themeKey) { themeKey = ink + brand; styles = ramp(ink, brand); }

			const unit = Math.min(width, height);
			const R = unit * (width < 640 ? 0.4 : 0.34), W = R * 0.52;
			const cx = width / 2, cy = height / 2;
			// the band turns about its axis and rocks gently, tilted toward the viewer
			const spin = time * 0.12, tilt = 1.05 + 0.12 * Math.sin(time * 0.2), roll = 0.25 * Math.sin(time * 0.13);
			const cs = Math.cos(spin), ss = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
			const camera = unit * 2.2;
			// pulses: one leaves u = 0 every INTERVAL seconds; each is a gaussian travelling around the band
			const head = (time / LAP) * TAU;
			const spacing = (INTERVAL / LAP) * TAU;

			for (let i = 0; i < LATTICE.length; i++) {
				const { u, v } = LATTICE[i]!;
				const half = u / 2, w = v * W;
				// its normal, for the light (sign-free: both faces are lit) and for the wave
				const nx = Math.cos(u) * Math.sin(half), ny = Math.sin(u) * Math.sin(half), nz = -Math.cos(half);
				// the wave: ripples travel around the band, displacing the surface along its normal; they fade toward the edges
				const wave = R * 0.075 * (Math.sin(3 * u - time * 0.9 + v * 1.4) + 0.5 * Math.sin(5 * u + time * 0.6 - v * 2.2)) * (1 - 0.4 * v * v);
				// Möbius strip: the cross-section turns half a revolution per lap
				let x = (R + w * Math.cos(half)) * Math.cos(u) + nx * wave, y = (R + w * Math.cos(half)) * Math.sin(u) + ny * wave, z = w * Math.sin(half) + nz * wave;
				// rotate: spin about z, tilt about x, roll about y
				let rx = x * cs - y * ss, ry = x * ss + y * cs;
				x = rx; y = ry;
				ry = y * ct - z * st; let rz = y * st + z * ct;
				y = ry; z = rz;
				rx = x * cr + z * sr; rz = -x * sr + z * cr;
				x = rx; z = rz;
				const mx = nx * cs - ny * ss, my0 = nx * ss + ny * cs;
				const mz0 = my0 * st + nz * ct;
				const mz = -mx * sr + mz0 * cr;
				const p = camera / (camera - z);
				xs[i] = cx + x * p;
				ys[i] = cy + y * p;
				zs[i] = z;
				// facing the viewer (either side of the band) and nearer = brighter
				lit[i] = 0.35 + 0.65 * Math.abs(mz) * (0.7 + 0.3 * (z / R + 1) / 2);
				// distance behind the newest pulse head along the band, folded onto the pulse spacing
				const behind = ((head - u) % TAU + TAU) % TAU;
				const k = behind % spacing;
				const d = Math.min(k, spacing - k);
				heat[i] = Math.exp(-((d / PULSE_WIDTH) ** 2)) * (1 - 0.35 * Math.abs(v));
			}
			order.sort((a, b) => zs[a]! - zs[b]!);

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			const base = dark ? 0.55 : 0.42;
			for (const i of order) {
				const h = heat[i]!, l = lit[i]!;
				const depth = (zs[i]! / R + 1) / 2;
				ctx.globalAlpha = Math.min(1, base * l + h * 0.9);
				ctx.fillStyle = styles[Math.min(LEVELS - 1, Math.round(h * (LEVELS - 1)))]!;
				const r = (0.55 + 0.75 * depth) * (1 + 0.5 * h);
				ctx.beginPath();
				ctx.arc(xs[i]!, ys[i]!, r, 0, TAU);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
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
		const [ink, brand] = root.querySelectorAll<HTMLElement>('[data-swatch]');
		if (!(canvas instanceof HTMLCanvasElement) || ink === undefined || brand === undefined) return;
		return band(canvas, ink, brand);
	}}>
	<canvas></canvas>
	<span data-swatch class="text-foreground"></span>
	<span data-swatch class="text-brand dark:text-brand-400"></span>
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
