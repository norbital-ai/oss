<script lang="ts">
	import { attachDotField, markRadius } from './dot-field.js';
	import { NORBIUS_STRIP_STATES, norbiusStripGeometry, type NorbiusStripState } from './norbius-geometry.js';

	/**
	 * Norbius's mark: a band of dots that moves with the agent's state (ready, working, waiting, done, stopped, error).
	 * With `label` it is an image; without, decoration.
	 */
	let { state = 'ready', size = 20, label, class: className = '' }: { state?: NorbiusStripState; size?: number; label?: string; class?: string } = $props();

	/** The live attribute Svelte keeps in sync: the attach closure must not snapshot `state`. */
	const liveState = (root: Element): NorbiusStripState => {
		const v = root.getAttribute('data-state');
		return (NORBIUS_STRIP_STATES as readonly string[]).includes(v ?? '') ? v as NorbiusStripState : 'ready';
	};
</script>

<!-- the box is sized inline: a code-split sheet cannot size chrome through a stylesheet that has not loaded -->
<span
	class="norbital-norbius-strip {className}"
	data-state={state}
	style="width: {size}px; height: {size}px; display: grid; place-items: center; position: relative; flex: none"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const swatch = root.querySelector('[data-swatch]');
		if (!(canvas instanceof HTMLCanvasElement) || !(swatch instanceof HTMLElement)) return;
		return attachDotField(root, canvas, swatch, { geometry: norbiusStripGeometry, size, radius: markRadius(size), readState: liveState, transitionMs: size <= 24 ? 145 : 520 });
	}}
>
	<canvas aria-hidden="true" style="display: block; width: 100%; height: 100%"></canvas>
	<span data-swatch aria-hidden="true" style="color: var(--strip-accent)"></span>
</span>

<style>
	.norbital-norbius-strip {
		--strip-accent: var(--product-icon-accent, var(--color-brand));
		color: currentColor;
		contain: strict;
	}
	.norbital-norbius-strip[data-state='error'] {
		color: var(--color-destructive);
		--strip-accent: var(--color-destructive);
	}
	[data-swatch] {
		position: absolute;
		width: 0;
		height: 0;
		visibility: hidden;
	}
</style>
