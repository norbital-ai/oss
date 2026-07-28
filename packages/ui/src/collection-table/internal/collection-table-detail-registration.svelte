<script lang="ts">
	import type {
		CollectionTableDetailRenderContext,
		CollectionTableNavigation
	} from '../collection-table-navigation.svelte.js';
	import { onMount, type Snippet } from 'svelte';

	let {
		navigation,
		routeKey,
		parentRouteKey,
		renderDetail
	}: {
		navigation: CollectionTableNavigation;
		routeKey: string;
		parentRouteKey?: string;
		renderDetail: Snippet<[CollectionTableDetailRenderContext]>;
	} = $props();

	// The parent keys this component by route identity, so registration belongs to the mount lifecycle.
	// A reactive effect would subscribe to the registry revision that register itself increments.
	onMount(() => {
		return navigation.register({ routeKey, parentRouteKey, renderDetail });
	});
</script>
