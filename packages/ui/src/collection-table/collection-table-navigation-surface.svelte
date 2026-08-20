<script lang="ts">
	import type { Snippet } from 'svelte';
	import { CollectionDetailPreferences } from './collection-detail-preferences.svelte.js';
	import CollectionTableNavigationFrame from './internal/collection-table-navigation-frame.svelte';
	import {
		CollectionTableUrlNavigation,
		setCollectionTableNavigationContext
	} from './collection-table-navigation.svelte.js';

	let {
		url,
		navigate,
		children
	}: { url: URL; navigate: (href: string) => void; children: Snippet } = $props();
	const preferences = new CollectionDetailPreferences();
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => url,
		navigate: (href) => navigate(href)
	});
	setCollectionTableNavigationContext(navigation);
	const targets = $derived(navigation.targets);
</script>

{@render children()}

<!--
	One sheet per stack frame, shallowest first. Each renders its record from the collection name and
	record id in the URL, against the workspace's own client and representation registry — so a frame
	resolves whether or not the table that linked to it is mounted, on an open tab, or on screen at
	all. The sheets share a portal target and overlap, so the deepest frame is the one on top.
-->
{#each targets as target, depth (depth)}
	<CollectionTableNavigationFrame {navigation} {target} {depth} {preferences} />
{/each}
