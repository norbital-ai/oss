<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Defines the possible values for the blob size preset.
	 * 'xs': Extra Small
	 * 'sm': Small
	 * 'md': Medium (Default)
	 * 'lg': Large
	 */
	type BlobSize = 'xs' | 'sm' | 'md' | 'lg';

	/**
	 * Props for the DynamicBackground component.
	 * @property {string[]} [colors] - An array of Tailwind CSS background color classes for the blobs.
	 * @property {BlobSize} [size='md'] - A size preset for the blobs.
	 * @property {Snippet} children - The content to be rendered on top of the background.
	 */
	let {
		colors = ['bg-indigo-600', 'bg-blue-600', 'bg-purple-600'],
		size = 'md',
		children
	}: {
		colors?: string[];
		size?: BlobSize;
		children: Snippet;
	} = $props();

	/**
	 * Base definitions for the blobs, including position, base size, and animation.
	 * The final size will be calculated from `base_size` and the `size` prop.
	 */
	const base_blob_definitions = [
		{
			top: '10%',
			left: '10%',
			base_size: 450,
			animation: 'blob-1-animation 15s infinite alternate'
		},
		{
			top: '30%',
			left: '50%',
			base_size: 350,
			animation: 'blob-2-animation 18s infinite alternate'
		},
		{
			top: '60%',
			left: '20%',
			base_size: 250,
			animation: 'blob-3-animation 12s infinite alternate'
		},
		{
			top: '50%',
			left: '80%',
			base_size: 400,
			animation: 'blob-1-animation 16s infinite alternate'
		}
	];

	/**
	 * A derived state that reactively calculates the final inline styles for the blobs
	 * whenever the `size` prop changes.
	 */
	const final_blob_styles = $derived.by(() => {
		const multipliers = { xs: 0.4, sm: 0.6, md: 1.0, lg: 1.4 };
		const multiplier = multipliers[size];

		return base_blob_definitions.map((def) => {
			const final_size = def.base_size * multiplier;
			return `top: ${def.top}; left: ${def.left}; width: ${final_size}px; height: ${final_size}px; animation: ${def.animation};`;
		});
	});
</script>

<div class="relative w-full overflow-hidden">
	<div class="pointer-events-none absolute inset-0 z-0 h-full w-full blur-[100px]">
		{#each colors as color, i}
			{@const style = final_blob_styles[i % final_blob_styles.length]}
			<div class="absolute rounded-full opacity-70 {color}" {style}></div>
		{/each}
	</div>

	<div class="relative z-10">
		{@render children()}
	</div>
</div>

<style>
	/**
	 * Defines the animations for the blobs. Animating the `transform` property
	 * makes them move, rotate, and scale independently, creating a
	 * fluid, non-repeating, and organic motion.
	 *
	 * Using :global {} ensures these animations work across all contexts
	 * and aren't scoped by Svelte, which is necessary for inline style animations.
	 */
	:global {
		@keyframes blob-1-animation {
			from {
				transform: translate(-20%, 10%) scale(1) rotate(0deg);
			}
			to {
				transform: translate(20%, -15%) scale(1.2) rotate(45deg);
			}
		}

		@keyframes blob-2-animation {
			from {
				transform: translate(-10%, -10%) scale(0.9) rotate(20deg);
			}
			to {
				transform: translate(15%, 15%) scale(1.1) rotate(-20deg);
			}
		}

		@keyframes blob-3-animation {
			from {
				transform: translate(15%, -20%) scale(1.1) rotate(-30deg);
			}
			to {
				transform: translate(-10%, 10%) scale(0.8) rotate(30deg);
			}
		}
	}
</style>
