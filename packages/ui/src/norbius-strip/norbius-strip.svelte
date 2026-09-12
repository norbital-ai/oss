<script lang="ts" module>
	import { Schema } from 'effect';
	import { NORBIUS_STRIP_STATES } from './geometry.js';

	/**
	 * The union lives beside the component rather than in the Bolt agent runtime because the strip
	 * is a shared primitive — the product icon renders one to stand for AI without importing a
	 * transcript projector. Bolt re-exports it as `AgentOrbState`, which keeps the runtime's own
	 * vocabulary intact.
	 */
	export const NorbiusStripStateSchema = Schema.Literals(NORBIUS_STRIP_STATES);
	export type { NorbiusStripState } from './geometry.js';
</script>

<script lang="ts">
	import { attachDotField, markRadius } from '#lib/dot-field';
	import { norbiusStripGeometry, type NorbiusStripState } from './geometry.js';

	let {
		state = 'ready',
		size = 20,
		label,
		class: className = ''
	}: {
		state?: NorbiusStripState;
		size?: number;
		label?: string;
		class?: string;
	} = $props();

	/** Read the live attribute Svelte keeps in sync — the attach closure must not snapshot `state`. */
	function liveState(root: Element): NorbiusStripState {
		const value = root.getAttribute('data-state');
		return value !== null && Schema.is(NorbiusStripStateSchema)(value) ? value : 'ready';
	}
</script>

<!--
	The box is inline, not only in the stylesheet below.

	Vite assigns a component's scoped CSS to whichever chunk it lands in, and this component's sheet
	can be emitted into a lazily-loaded one while the strip itself renders in the sidebar, which is
	present on every page. Until something loaded that chunk the mark had no rules at all: a bare
	`<canvas>` is 300x150 by specification, so it drew scattered dots across half the sidebar. The
	rules below still carry state colour and the accent swatch; what a shell-chrome component cannot
	afford to inherit from a code-split sheet is its own size.
-->
<span
	class={`norbital-norbius-strip ${className}`}
	data-state={state}
	style={`width: ${size}px; height: ${size}px; display: grid; place-items: center; position: relative; flex: none`}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{@attach (root) => {
		const canvas = root.querySelector('canvas');
		const swatch = root.querySelector('.strip-accent-swatch');
		if (!(canvas instanceof HTMLCanvasElement) || !(swatch instanceof HTMLElement)) return;
		return attachDotField(root, canvas, swatch, {
			geometry: norbiusStripGeometry,
			size,
			radius: markRadius(size),
			readState: liveState,
			// Long enough to see, short enough not to read as lag. At 16px in the sidebar the move
			// is a few pixels and a long one just looks like the icon is behind.
			transitionMs: size <= 24 ? 145 : 520
		});
	}}
>
	<canvas aria-hidden="true" style="display: block; width: 100%; height: 100%"></canvas>
	<span class="strip-accent-swatch" aria-hidden="true"></span>
</span>

<style>
	.norbital-norbius-strip {
		--strip-accent: var(--product-icon-accent, var(--color-brand));
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		color: currentColor;
		contain: strict;
	}

	.norbital-norbius-strip[data-state='error'] {
		color: var(--color-destructive);
		--strip-accent: var(--color-destructive);
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	.strip-accent-swatch {
		position: absolute;
		width: 0;
		height: 0;
		color: var(--strip-accent);
		visibility: hidden;
	}
</style>
