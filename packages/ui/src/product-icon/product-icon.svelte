<script lang="ts">
	import type { SVGAttributes } from 'svelte/elements';
	import { productLayerIconGeometry, type ProductIconName } from '#lib/product-icon/product-icons';
	import { ThinkingOrb } from '#lib/thinking-orb';

	let {
		name,
		/** The Agent orb's square size in px — the static product icons scale via `size-*` classes. */
		size = 16,
		class: className = '',
		...restProps
	}: SVGAttributes<SVGSVGElement> & {
		name: ProductIconName;
		size?: number;
		class?: string;
	} = $props();

	const layerGeometry = $derived(productLayerIconGeometry(name));
</script>

{#if name === 'agent'}
	<!-- The Agent mark is the thinking orb itself — the same animated sphere live surfaces render,
	     so a listed `product:agent` means what the workspace means by an agent. -->
	<ThinkingOrb {size} class={className} />
{:else}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={`product-icon ${className}`}
		data-product-icon={name}
		aria-hidden="true"
		{...restProps}
	>
		{#if layerGeometry}
			{#each layerGeometry as primitive}
				{#if primitive.kind === 'path'}
					<path d={primitive.d} class={primitive.accent ? 'accent-stroke' : undefined} />
				{:else if primitive.kind === 'ellipse'}
					<ellipse
						cx={primitive.cx}
						cy={primitive.cy}
						rx={primitive.rx}
						ry={primitive.ry}
						class={primitive.accent ? 'accent-stroke' : undefined}
					/>
				{:else if primitive.kind === 'circle'}
					<circle
						cx={primitive.cx}
						cy={primitive.cy}
						r={primitive.r}
						class={primitive.accent ? 'accent-stroke' : undefined}
					/>
				{:else}
					<rect
						x={primitive.x}
						y={primitive.y}
						width={primitive.width}
						height={primitive.height}
						rx={primitive.rx}
						class={primitive.accent ? 'accent-stroke' : undefined}
					/>
				{/if}
			{/each}
		{:else if name === 'bolt'}
			<!-- The sealed bundle a workspace compiles to: one solid, one seam. -->
			<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
			<path d="M8.5 12h7" class="accent-stroke" />
		{:else if name === 'colony'}
			<!-- Three honeycomb cells: two above, one below, and the middle cell wears the brand. -->
			<path d="M10.4 10.3 6.5 12.5 2.6 10.3 2.6 5.8 6.5 3.5 10.4 5.8Z" />
			<path d="M21.4 10.3 17.5 12.5 13.6 10.3 13.6 5.8 17.5 3.5 21.4 5.8Z" />
			<path d="M15.9 19.8 12 22 8.1 19.8 8.1 15.3 12 13 15.9 15.3Z" class="accent-stroke" />
		{:else if name === 'models'}
			<rect x="4" y="3" width="16" height="18" rx="2" />
			<path d="M8 8h8M8 12h8M8 16h5" />
			<path d="M8 8h3" class="accent-stroke" />
		{:else if name === 'collections'}
			<rect x="4" y="4" width="16" height="16" rx="2" />
			<path d="M9 4v16" class="accent-stroke" />
		{:else if name === 'relations'}
			<path d="m7.5 7.5 3.5 7M16.5 7.5l-3.5 7" />
			<path d="M8 6h8" class="accent-stroke" />
			<circle cx="6" cy="6" r="2" />
			<circle cx="18" cy="6" r="2" />
			<circle cx="12" cy="17" r="2" />
		{:else if name === 'policies'}
			<path d="M4 6h7M15 6h5M4 12h2M10 12h10M4 18h9M17 18h3" />
			<circle cx="13" cy="6" r="2" />
			<circle cx="8" cy="12" r="2" class="accent-stroke" />
			<circle cx="15" cy="18" r="2" />
		{:else if name === 'approvals'}
			<circle cx="12" cy="12" r="8" />
			<path d="m8.5 12 2.2 2.2 4.8-5" class="accent-stroke" />
		{:else if name === 'audit'}
			<circle cx="12" cy="12" r="8" />
			<path d="M12 7v5" />
			<path d="m12 12 3 2" class="accent-stroke" />
		{:else if name === 'hooks'}
			<path d="M6 8v5a6 6 0 0 0 12 0v-1" />
			<path d="M6 4v4" class="accent-stroke" />
		{:else if name === 'pipelines'}
			<path d="M8 8h9m-3-3 3 3-3 3M20 16H7m3-3-3 3 3 3" />
			<path d="M4 8h4" class="accent-stroke" />
		{:else if name === 'integrations'}
			<path
				d="M10 15.5 8.5 17a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M14 8.5 15.5 7a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"
			/>
			<path d="m10 14 4-4" class="accent-stroke" />
		{:else if name === 'automations'}
			<path d="M20 11a8 8 0 1 0-2.3 5.7" />
			<path d="M20 4v7h-7" class="accent-stroke" />
		{:else if name === 'remotes'}
			<path d="m8 6-5 6 5 6M16 6l5 6-5 6" />
			<path d="m11 9 2 6" class="accent-stroke" />
		{:else if name === 'apps'}
			<rect x="3" y="3" width="7" height="7" rx="1" />
			<rect x="14" y="3" width="7" height="7" rx="1" />
			<rect x="3" y="14" width="7" height="7" rx="1" />
			<rect x="14" y="14" width="7" height="7" rx="1" class="accent-stroke" />
		{:else if name === 'studio'}
			<path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
			<path d="m8 17 8-8" class="accent-stroke" />
		{:else if name === 'environment'}
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="m7 9 2 2-2 2" class="accent-stroke" />
			<path d="M12 15h5" />
		{:else if name === 'organization'}
			<path d="M12 6v6M6 12h12M6 12v5M18 12v2" />
			<path d="M18 14v3" class="accent-stroke" />
			<circle cx="12" cy="6" r="1.7" />
			<circle cx="6" cy="18" r="1.7" />
			<circle cx="18" cy="18" r="1.7" />
		{:else if name === 'documentation'}
			<path
				d="M4 6c3-1 5.7-.5 8 1.2V20c-2.3-1.7-5-2.2-8-1.2V6ZM20 6c-3-1-5.7-.5-8 1.2V20c2.3-1.7 5-2.2 8-1.2V6Z"
			/>
			<path d="M12 7v13" class="accent-stroke" />
		{:else if name === 'quick-start'}
			<path d="M6 18 15 9" />
			<path d="m15 9 3-3M11 6h7v7" class="accent-stroke" />
		{:else if name === 'concepts'}
			<circle cx="12" cy="12" r="2" />
			<circle cx="5" cy="7" r="2" />
			<circle cx="19" cy="6" r="2" />
			<path d="m6.6 8.2 3.8 2.6" />
			<path d="m13.6 10.8 3.8-3.5" class="accent-stroke" />
		{:else if name === 'api'}
			<path
				d="M9 5H7a2 2 0 0 0-2 2v2c0 2-1 3-2 3 1 0 2 1 2 3v2a2 2 0 0 0 2 2h2M15 5h2a2 2 0 0 1 2 2v2c0 2 1 3 2 3-1 0-2 1-2 3v2a2 2 0 0 1-2 2h-2"
			/>
			<path d="M10.5 12h3" class="accent-stroke" />
		{:else if name === 'deployment'}
			<path d="m5 15 7 4 7-4M5 10l7 4 7-4" />
			<path d="M12 11V4m-3 3 3-3 3 3" class="accent-stroke" />
		{:else if name === 'examples'}
			<rect x="4" y="5" width="11" height="12" rx="2" />
			<rect x="9" y="8" width="11" height="11" rx="2" />
			<path d="M15 8h3a2 2 0 0 1 2 2v3" class="accent-stroke" />
		{:else}
			<circle cx="12" cy="12" r="8" />
			<path d="M15.5 4.8A8 8 0 0 1 19 8" class="accent-stroke" />
		{/if}
	</svg>
{/if}

<style>
	.product-icon {
		display: inline-block;
		overflow: visible;
		color: currentColor;
	}

	.accent-stroke {
		stroke: var(--product-icon-accent, var(--color-brand));
	}
</style>
