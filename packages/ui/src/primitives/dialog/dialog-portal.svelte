<script lang="ts">
	import type { Snippet } from 'svelte';
	import { portal, type PortalTarget } from '../../behaviors/index.js';

	let {
		to,
		disabled = false,
		children
	}: {
		/** Explicit portal container (element or selector); omitted inherits `PortalConfig` or `document.body`. */
		to?: PortalTarget;
		/** Render children in place without teleporting. */
		disabled?: boolean;
		/** Portaled content. */
		children?: Snippet;
	} = $props();
</script>

{#if disabled}
	{@render children?.()}
{:else}
	<div {@attach portal(to)} class="contents" data-portal>
		{@render children?.()}
	</div>
{/if}
