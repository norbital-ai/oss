<script lang="ts">
	import { attachDotField } from '#lib/dot-field';
	import { accretionDiscGeometry } from './geometry.js';

	/**
	 * The loading mark: a black hole's accretion disc in dots, at the size a full surface can carry.
	 * A 16px spinner on a full viewport says the page is busy; the disc says which product is
	 * coming back.
	 */
	let {
		size = 96,
		label,
		class: className = ''
	}: {
		size?: number;
		label?: string;
		class?: string;
	} = $props();
</script>

<!-- The box is inline for the same reason as the strip's: a code-split sheet cannot size chrome. -->
<span
	class={`norbital-accretion-disc ${className}`}
	style={`width: ${size}px; height: ${size}px; display: grid; place-items: center; position: relative; flex: none`}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const swatch = root.querySelector('.disc-accent-swatch');
		if (!(canvas instanceof HTMLCanvasElement) || !(swatch instanceof HTMLElement)) return;
		return attachDotField(root, canvas, swatch, {
			geometry: accretionDiscGeometry,
			size,
			// The disc is wider than tall and sits alone, so it reaches further into its box than
			// the strip does beside icons.
			radius: 0.46,
			readState: () => 'ready',
			transitionMs: 1
		});
	}}
>
	<canvas aria-hidden="true" style="display: block; width: 100%; height: 100%"></canvas>
	<span class="disc-accent-swatch" aria-hidden="true"></span>
</span>

<style>
	.norbital-accretion-disc {
		position: relative;
		display: grid;
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

	/* Monochrome: the swatch exists for the engine's contract, and carries the ink colour. */
	.disc-accent-swatch {
		position: absolute;
		width: 0;
		height: 0;
		color: currentColor;
		visibility: hidden;
	}
</style>
