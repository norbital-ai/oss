<!-- fallow-ignore-file unrendered-component -- exported package status indicator rendered by Core agent surfaces -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import type { ThinkingOrbState } from './thinking-orb.types.js';

	let {
		state = 'thinking',
		animated = true,
		class: className,
		label
	}: {
		state?: ThinkingOrbState;
		animated?: boolean;
		class?: string;
		label?: string;
	} = $props();

	const accessibleLabel = $derived(label ?? `${state[0]?.toUpperCase()}${state.slice(1)}`);
</script>

<svg
	viewBox="0 0 24 24"
	fill="none"
	class={cn('thinking-orb size-4', animated && 'is-animated', className)}
	data-state={state}
	role="status"
	aria-label={accessibleLabel}
>
	{#if state === 'thinking'}
		<circle cx="12" cy="12" r="8" class="dotted-orbit" />
		<g class="orbit-points">
			<circle cx="12" cy="4" r="0.75" />
			<circle cx="17.65" cy="6.35" r="0.58" class="soft" />
			<circle cx="20" cy="12" r="0.78" class="accent" />
			<circle cx="17.65" cy="17.65" r="0.52" class="soft" />
			<circle cx="12" cy="20" r="0.72" />
			<circle cx="6.35" cy="17.65" r="0.52" class="soft" />
			<circle cx="4" cy="12" r="0.72" />
			<circle cx="6.35" cy="6.35" r="0.58" class="soft" />
		</g>
		<circle cx="12" cy="12" r="1.25" class="accent orb-pulse" />
	{:else if state === 'searching'}
		<ellipse cx="12" cy="12" rx="8.25" ry="4.2" class="orb-line soft" />
		<ellipse
			cx="12"
			cy="12"
			rx="8.25"
			ry="4.2"
			transform="rotate(60 12 12)"
			class="orb-line soft"
		/>
		<ellipse
			cx="12"
			cy="12"
			rx="8.25"
			ry="4.2"
			transform="rotate(120 12 12)"
			class="orb-line soft"
		/>
		<g class="search-point">
			<circle cx="20.25" cy="12" r="1.15" class="accent" />
		</g>
		<circle cx="12" cy="12" r="0.9" />
	{:else if state === 'listening'}
		<circle cx="12" cy="12" r="1.35" class="accent orb-pulse" />
		<path
			d="M8.75 8.75a4.6 4.6 0 0 0 0 6.5M15.25 8.75a4.6 4.6 0 0 1 0 6.5"
			class="orb-line wave-one"
		/>
		<path d="M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12" class="orb-line soft wave-two" />
	{:else if state === 'working'}
		<g class="working-field">
			<circle cx="12" cy="12" r="7.75" class="dotted-orbit" />
			<path d="M12 4.25a7.75 7.75 0 0 1 6.7 3.85" class="orb-line work-sweep" />
			<circle cx="18.7" cy="8.1" r="1.1" class="accent" />
			<circle cx="8.25" cy="14.5" r="1.15" class="orb-pulse" />
			<circle cx="14.5" cy="15.75" r="0.72" class="soft" />
		</g>
	{:else}
		<circle cx="12" cy="12" r="7.75" class="dotted-orbit" />
		<circle cx="12" cy="12" r="1.15" class="accent" />
	{/if}
</svg>

<style>
	.thinking-orb {
		display: block;
		overflow: visible;
		color: currentColor;
	}

	.thinking-orb :global(*) {
		vector-effect: non-scaling-stroke;
	}

	.thinking-orb circle:not(.dotted-orbit),
	.thinking-orb .accent {
		fill: currentColor;
	}

	.orb-line,
	.dotted-orbit {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.25;
		stroke-linecap: round;
	}

	.dotted-orbit {
		stroke-dasharray: 0.55 1.85;
		opacity: 0.46;
	}

	.soft {
		opacity: 0.42;
	}

	.thinking-orb .accent {
		fill: var(--product-icon-accent, var(--color-brand));
		stroke: none;
	}

	.is-animated .orbit-points,
	.is-animated .working-field {
		transform-box: view-box;
		transform-origin: center;
		animation: orb-rotate 7s linear infinite;
	}

	.is-animated .search-point {
		transform-box: view-box;
		transform-origin: center;
		animation: orb-rotate 2.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	.is-animated .orb-pulse {
		transform-box: view-box;
		transform-origin: center;
		animation: orb-pulse 2.2s ease-in-out infinite;
	}

	.is-animated .wave-one {
		animation: wave-breathe 1.8s ease-in-out infinite;
	}

	.is-animated .wave-two {
		animation: wave-breathe 1.8s 0.35s ease-in-out infinite;
	}

	@keyframes orb-rotate {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes orb-pulse {
		50% {
			transform: scale(0.65);
			opacity: 0.58;
		}
	}

	@keyframes wave-breathe {
		50% {
			opacity: 0.28;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.is-animated .orbit-points,
		.is-animated .working-field,
		.is-animated .search-point,
		.is-animated .orb-pulse,
		.is-animated .wave-one,
		.is-animated .wave-two {
			animation: none;
		}
	}
</style>
