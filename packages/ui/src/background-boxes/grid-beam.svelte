<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		ref?: HTMLDivElement | null;
		children?: Snippet;
	} = $props();
</script>

<div bind:this={ref} class={cn('relative h-full w-full', className)} {...restProps}>
	<!-- Grid-aligned beams - each segment aligns with 64px (16*4) grid cells -->
	<svg
		class="pointer-events-none absolute top-1/2 left-1/2 h-full w-full -translate-x-1/2 -translate-y-1/2"
		xmlns="http://www.w3.org/2000/svg"
		width="100%"
		height="100%"
	>
		<defs>
			<linearGradient id="beam-gradient-1" gradientUnits="userSpaceOnUse">
				<stop offset="0%" stop-color="#3B82F6" stop-opacity="0" />
				<stop offset="50%" stop-color="#3B82F6" stop-opacity="0.6" />
				<stop offset="100%" stop-color="#3B82F6" stop-opacity="0" />
				<animate
					attributeName="x1"
					values="0%;0%;100%"
					dur="3s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
				/>
				<animate
					attributeName="x2"
					values="0%;30%;100%"
					dur="3s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
				/>
			</linearGradient>

			<linearGradient id="beam-gradient-2" gradientUnits="userSpaceOnUse">
				<stop offset="0%" stop-color="#3B82F6" stop-opacity="0" />
				<stop offset="50%" stop-color="#3B82F6" stop-opacity="0.6" />
				<stop offset="100%" stop-color="#3B82F6" stop-opacity="0" />
				<animate
					attributeName="y1"
					values="0%;0%;100%"
					dur="3.5s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
					begin="0.5s"
				/>
				<animate
					attributeName="y2"
					values="0%;30%;100%"
					dur="3.5s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
					begin="0.5s"
				/>
			</linearGradient>

			<linearGradient id="beam-gradient-3" gradientUnits="userSpaceOnUse">
				<stop offset="0%" stop-color="#3B82F6" stop-opacity="0" />
				<stop offset="50%" stop-color="#3B82F6" stop-opacity="0.6" />
				<stop offset="100%" stop-color="#3B82F6" stop-opacity="0" />
				<animate
					attributeName="x1"
					values="0%;0%;100%"
					dur="2.5s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
					begin="1s"
				/>
				<animate
					attributeName="x2"
					values="0%;30%;100%"
					dur="2.5s"
					repeatCount="indefinite"
					keyTimes="0;0.3;1"
					begin="1s"
				/>
			</linearGradient>
		</defs>

		<!-- Grid-aligned paths (following 64px grid) -->
		<!-- Horizontal beam across top (at 128px down) -->
		<path
			d="M64 128 h192 M256 128 h192 M448 128 h192"
			stroke="url(#beam-gradient-1)"
			stroke-width="3"
			fill="none"
		/>

		<!-- Vertical beam down left side (at 192px from left) -->
		<path
			d="M192 64 V256 M192 256 V448"
			stroke="url(#beam-gradient-2)"
			stroke-width="3"
			fill="none"
		/>

		<!-- L-shaped beam (grid-aligned corners) -->
		<path
			d="M384 192 h256 M640 192 V384"
			stroke="url(#beam-gradient-3)"
			stroke-width="3"
			fill="none"
		/>
	</svg>

	<!-- Content -->
	<div class="relative">
		{@render children?.()}
	</div>
</div>
