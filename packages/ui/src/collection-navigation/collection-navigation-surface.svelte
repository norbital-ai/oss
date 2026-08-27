<script lang="ts">
	import type { Snippet } from 'svelte';
	import { CollectionDetailPreferences } from '../collection-table/collection-detail-preferences.svelte.js';
	import CollectionNavigationFrame from './collection-navigation-frame.svelte';
	import {
		CollectionUrlNavigation,
		setCollectionNavigationContext
	} from './collection-navigation.svelte.js';

	let {
		url,
		navigate,
		children
	}: { url: URL; navigate: (href: string) => void; children: Snippet } = $props();
	const preferences = new CollectionDetailPreferences();
	const navigation = new CollectionUrlNavigation({
		getUrl: () => url,
		navigate: (href) => navigate(href)
	});
	setCollectionNavigationContext(navigation);
	const targets = $derived(navigation.targets);
</script>

{@render children()}

<!--
	One sheet per stack frame, shallowest first. Each renders its record from the collection name and
	record id in the URL, against the workspace's own client and representation registry — so a frame
	resolves whether or not the collection surface that linked to it is mounted, open, or on screen at
	all. The sheets share a portal target and overlap, so the deepest frame is the one on top.
-->
{#each targets as target, depth (depth)}
	<CollectionNavigationFrame {navigation} {target} {depth} {preferences} />
{/each}
