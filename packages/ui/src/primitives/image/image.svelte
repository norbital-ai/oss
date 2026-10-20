<!--
@component
A native image with an animated pending mosaic and a short dissolve when ready. An absent `src`/`srcset` stays pending
without requesting a placeholder. `class` reserves the outer span's size; `imageClass` controls the image's fit.
Native dimensions, responsive sources and loading attributes pass through; provide `alt=""` for decorative images.
-->
<script lang="ts" module>
	import type { HTMLImgAttributes } from 'svelte/elements';

	/** Native image attributes with required alternative text and separate container/image styling. */
	export type ImageProps = Omit<HTMLImgAttributes, 'alt'> & {
		alt: string;
		imageClass?: HTMLImgAttributes['class'];
	};

	const blend = (from: number, to: number, amount: number) => from + (to - from) * amount;
	const smooth = (value: number) => value * value * (3 - 2 * value);
	const hash = (x: number, y: number, time: number) => {
		let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(time, 1274126177);
		value = Math.imul(value ^ (value >>> 13), 1274126177);
		return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
	};
	// Interpolate neighbouring lattice values in space and time; cells never jump between poses.
	const field = (x: number, y: number, time: number) => {
		const column = Math.floor(x);
		const row = Math.floor(y);
		const plane = Math.floor(time);
		const horizontal = smooth(x - column);
		const vertical = smooth(y - row);
		const sample = (tick: number) =>
			blend(
				blend(hash(column, row, tick), hash(column + 1, row, tick), horizontal),
				blend(hash(column, row + 1, tick), hash(column + 1, row + 1, tick), horizontal),
				vertical
			);
		return blend(sample(plane), sample(plane + 1), smooth(time - plane));
	};
</script>

<script lang="ts">
	import { cn } from '../utils.js';

	let {
		src,
		srcset,
		sizes,
		alt,
		loading = 'lazy',
		decoding = 'async',
		class: className,
		imageClass,
		onload,
		onerror,
		...attributes
	}: ImageProps = $props();
	let image = $state<HTMLImageElement>();
	let settled = $state<{ source: string; state: 'loaded' | 'error' }>();
	const source = $derived(JSON.stringify([src ?? null, srcset ?? null, sizes ?? null]));
	const phase = $derived(settled?.source === source ? settled.state : 'pending');

	// A cached or server-rendered image may have finished before its listeners were attached.
	$effect(() => {
		const node = image;
		if (node?.complete && (src || srcset))
			settled = { source, state: node.naturalWidth > 0 ? 'loaded' : 'error' };
	});

	const mosaic = (node: HTMLCanvasElement) => {
		const owner = node.ownerDocument;
		const view = owner.defaultView;
		const context = node.getContext('2d', { alpha: false });
		if (!context || !view?.requestAnimationFrame) return;
		const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
		const seed = Math.random() * 1024;
		let pixels: ImageData;
		let elapsed = 0;
		let previous: number | undefined;
		let painted = -Infinity;
		let frame: number | undefined;
		let disposed = false;
		let visible = typeof IntersectionObserver === 'undefined';
		const readColor = (color: string) => {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
			return { red, green, blue };
		};
		const readPalette = (style = view.getComputedStyle(node)) => ({
			background: style.backgroundColor,
			color: style.color,
			from: readColor(style.backgroundColor),
			to: readColor(style.color)
		});
		let palette: ReturnType<typeof readPalette>;
		const paint = () => {
			const time = seed + elapsed / 600;
			const { from, to } = palette;
			for (let y = 0; y < node.height; y++) {
				for (let x = 0; x < node.width; x++) {
					const value =
						field((x + 0.5) * 0.23, (y + 0.5) * 0.23, time) * 0.45 +
						field((x + 0.5) * 0.85 + 31, (y + 0.5) * 0.85 + 47, time * 1.25) * 0.55;
					const offset = (y * node.width + x) * 4;
					pixels.data[offset] = blend(from.red, to.red, value);
					pixels.data[offset + 1] = blend(from.green, to.green, value);
					pixels.data[offset + 2] = blend(from.blue, to.blue, value);
					pixels.data[offset + 3] = 255;
				}
			}
			context.putImageData(pixels, 0, 0);
		};
		const resize = () => {
			if (disposed) return;
			const { width, height } = node.getBoundingClientRect();
			const cell = Math.max(12, width / 128, height / 128);
			node.width = Math.max(1, Math.ceil(width / cell));
			node.height = Math.max(1, Math.ceil(height / cell));
			pixels = context.createImageData(node.width, node.height);
			palette = readPalette();
			paint();
		};
		const stop = () => {
			if (frame !== undefined) view.cancelAnimationFrame(frame);
			frame = undefined;
			previous = undefined;
		};
		const tick = (now: number) => {
			if (disposed) return;
			elapsed += previous === undefined ? 0 : now - previous;
			previous = now;
			if (now - painted >= 1000 / 30) {
				paint();
				painted = now;
			}
			frame = view.requestAnimationFrame(tick);
		};
		const update = () => {
			if (disposed) return;
			if (visible && !owner.hidden && !preference.matches) {
				if (frame === undefined) frame = view.requestAnimationFrame(tick);
			} else stop();
		};
		const visibility =
			typeof IntersectionObserver === 'undefined'
				? undefined
				: new IntersectionObserver(([entry]) => {
						if (disposed) return;
						visible = entry?.isIntersecting ?? false;
						update();
					});
		const size = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
		const theme = new MutationObserver(() => {
			if (disposed) return;
			const style = view.getComputedStyle(node);
			if (style.backgroundColor === palette.background && style.color === palette.color) return;
			palette = readPalette(style);
			paint();
		});
		for (let parent = node.parentElement; parent; parent = parent.parentElement)
			theme.observe(parent, {
				attributes: true,
				attributeFilter: ['class', 'style', 'data-theme']
			});
		resize();
		visibility?.observe(node);
		size?.observe(node);
		owner.addEventListener('visibilitychange', update);
		preference.addEventListener('change', update);
		update();
		return () => {
			disposed = true;
			stop();
			visibility?.disconnect();
			size?.disconnect();
			theme.disconnect();
			owner.removeEventListener('visibilitychange', update);
			preference.removeEventListener('change', update);
		};
	};
</script>

<span
	class={cn('norbital-image relative inline-grid overflow-hidden align-middle', className)}
	data-image
	data-state={phase}
>
	{#key source}
		<img
			bind:this={image}
			{...attributes}
			{src}
			{srcset}
			{sizes}
			{alt}
			{loading}
			{decoding}
			class={cn('block h-auto max-w-full', imageClass)}
			onload={(event) => {
				if (event.currentTarget === image) settled = { source, state: 'loaded' };
				onload?.(event);
			}}
			onerror={(event) => {
				if (event.currentTarget === image) settled = { source, state: 'error' };
				onerror?.(event);
			}}
		/>
		<canvas aria-hidden="true" {@attach phase === 'pending' ? mosaic : undefined}></canvas>
	{/key}
</span>

<style>
	.norbital-image[data-state='pending'] > img {
		opacity: 0;
	}

	.norbital-image > canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		opacity: 0;
		color: var(--color-background);
		background-color: color-mix(in oklab, var(--color-muted-foreground) 12%, var(--color-muted));
		image-rendering: pixelated;
	}

	.norbital-image[data-state='pending'] > canvas {
		opacity: 1;
	}

	.norbital-image[data-state='loaded'] > canvas {
		transition: opacity var(--motion-base, 180ms) var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1));
	}

	@media (prefers-reduced-motion: reduce) {
		.norbital-image[data-state='loaded'] > canvas {
			transition: none;
		}
	}
</style>
