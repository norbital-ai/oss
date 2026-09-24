<script lang="ts">
	import * as Sheet from '#lib/sheet';
	import { Bound } from '#lib/layout';
	import CollectionDetailActions from '../collection-table/collection-detail-actions.svelte';
	import CollectionRecordDetail from '../collection-table/collection-record-detail.svelte';
	import { untrack } from 'svelte';
	import {
		getOptionalCollectionClientContext,
		setCollectionClientContext
	} from '#lib/collection-runtime';
	import type { CollectionDetailPreferences } from '../collection-table/collection-detail-preferences.svelte.js';
	import type {
		CollectionNavigationTarget,
		CollectionUrlNavigation
	} from './collection-navigation.svelte.js';

	let {
		navigation,
		target,
		depth,
		preferences
	}: {
		navigation: CollectionUrlNavigation;
		target: CollectionNavigationTarget;
		/** Index of this frame in the URL stack; closing it truncates the stack to this length. */
		depth: number;
		preferences: CollectionDetailPreferences;
	} = $props();

	const fullScreen = $derived(preferences.isFullScreen(target.collectionName));
	const fallbackClient = getOptionalCollectionClientContext();
	const initialClient = untrack(
		() => navigation.detailClient(target.routeKey, target.collectionName) ?? fallbackClient
	);
	if (initialClient) {
		setCollectionClientContext(
			() =>
				navigation.detailClient(target.routeKey, target.collectionName) ??
				fallbackClient ??
				initialClient
		);
	}

	function toggleFullScreen(): void {
		preferences.toggleFullScreen(target.collectionName);
	}
</script>

{#snippet detailActions()}
	<CollectionDetailActions
		{fullScreen}
		onToggleFullScreen={toggleFullScreen}
		onClose={() => navigation.popTo(depth)}
	/>
{/snippet}

<!-- The frame exists exactly as long as its stack entry does, so it is mounted open. -->
<Sheet.Root open={true} onOpenChange={(open) => !open && navigation.popTo(depth)}>
	<Sheet.Content
		flush
		contained
		portalTarget="[data-slot='sidebar-inset']"
		// repository-health:allow UI21 -- sheet width on the bits-ui Dialog.Content that Sheet.Content renders and slides; Bound's sizes are heights and no primitive names a width, and a nested primitive would not size the sliding box
		class="w-[520px] sm:max-w-[520px]"
		showCloseButton={false}
		{fullScreen}
		onOpenAutoFocus={(event) => event.preventDefault()}
		onCloseAutoFocus={(event) => event.preventDefault()}
	>
		<Bound size="full" clip>
			<CollectionRecordDetail
				collectionName={target.collectionName}
				recordId={target.recordId}
				actions={detailActions}
				onClose={() => navigation.popTo(depth)}
			/>
		</Bound>
	</Sheet.Content>
</Sheet.Root>
