<script lang="ts">
	import { attachDotField } from './dot-field.js';
	import { accretionDiscGeometry } from './accretion-geometry.js';

	/**
	 * The loading mark: a black hole's accretion disc in dots, at the size a full surface can carry (the agent's orb
	 * while a turn runs). With `label` it is an image; without, decoration.
	 */
	let { size = 96, label, class: className = '' }: { size?: number; label?: string; class?: string } = $props();
</script>

<!-- the box is sized inline: a code-split sheet cannot size chrome through a stylesheet that has not loaded -->
<span
	class="norbital-accretion-disc {className}"
	style="width: {size}px; height: {size}px"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	data-accretion-disc
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const swatch = root.querySelector('[data-swatch]');
		if (!(canvas instanceof HTMLCanvasElement) || !(swatch instanceof HTMLElement)) return;
		// the disc is wider than tall and sits alone, so it reaches further into its box than the strip does
		return attachDotField(root, canvas, swatch, { geometry: accretionDiscGeometry, size, radius: 0.46, readState: () => 'ready', transitionMs: 1 });
	}}
>
	<canvas aria-hidden="true"></canvas>
	<span data-swatch class="text-brand" aria-hidden="true"></span>
</span>

<style>
	.norbital-accretion-disc {
		display: grid;
		place-items: center;
		position: relative;
		flex: none;
		color: currentColor;
		contain: strict;
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
