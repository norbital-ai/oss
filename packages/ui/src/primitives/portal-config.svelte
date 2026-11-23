<!--
@component
Scopes where descendant portaled overlays (dialogs, popovers, tooltips) mount in the DOM.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { set_portal_target, type PortalTarget } from '../behaviors/index.js';

	let {
		to,
		children
	}: {
		/** Mount element or CSS selector for descendant portals (default `document.body`). */
		to?: PortalTarget;
		/** Scoped subtree. */
		children?: Snippet;
	} = $props();

	set_portal_target(() => to);
</script>

{@render children?.()}
