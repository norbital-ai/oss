<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		class: className,
		label = 'Loading'
	}: {
		class?: string;
		label?: string;
	} = $props();
</script>

<svg
	viewBox="0 0 24 24"
	fill="none"
	class={cn('norbital-loader size-4', className)}
	role="status"
	aria-label={label}
>
	<circle cx="12" cy="12" r="8.25" class="loader-track" />
	<path d="M12 3.75a8.25 8.25 0 0 1 7.15 4.12" class="loader-sweep" />
	<circle cx="19.15" cy="7.87" r="1.25" class="loader-node" />
	<circle cx="5.4" cy="16.95" r="0.72" class="loader-satellite" />
</svg>

<style>
	.norbital-loader {
		display: block;
		overflow: visible;
		color: currentColor;
		transform-origin: center;
		animation: loader-orbit 1.35s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	.loader-track,
	.loader-sweep {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.45;
		vector-effect: non-scaling-stroke;
	}

	.loader-track {
		stroke-dasharray: 0.7 2.1;
		opacity: 0.32;
	}

	.loader-sweep {
		stroke-linecap: round;
	}

	.loader-node {
		fill: var(--product-icon-accent, var(--color-brand));
	}

	.loader-satellite {
		fill: currentColor;
		opacity: 0.58;
	}

	@keyframes loader-orbit {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.norbital-loader {
			animation: none;
		}
	}
</style>
