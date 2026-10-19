<!--
@component
A native image with a quiet pending mosaic and a short dissolve when ready. An absent `src`/`srcset` stays pending
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
	{/key}
</span>

<style>
	.norbital-image::after {
		position: absolute;
		inset: 0;
		content: '';
		pointer-events: none;
		opacity: 0;
		background-color: color-mix(in oklab, var(--color-muted) 80%, transparent);
		background-image:
			linear-gradient(var(--color-border), var(--color-border)),
			linear-gradient(var(--color-background), var(--color-background)),
			linear-gradient(var(--color-background), var(--color-background)),
			linear-gradient(var(--color-border), var(--color-border)),
			linear-gradient(var(--color-background), var(--color-background));
		background-size:
			25% 50%,
			25% 25%,
			50% 25%,
			25% 25%,
			25% 50%;
		background-position:
			0 0,
			33.333% 33.333%,
			100% 0,
			66.667% 100%,
			100% 100%;
		background-repeat: no-repeat;
	}

	.norbital-image[data-state='pending']::after {
		opacity: 1;
	}

	.norbital-image[data-state='loaded']::after {
		transition: opacity var(--motion-base, 180ms) var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1));
	}

	@media (prefers-reduced-motion: reduce) {
		.norbital-image[data-state='loaded']::after {
			transition: none;
		}
	}
</style>
