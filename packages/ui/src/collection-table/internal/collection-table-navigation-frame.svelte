<script lang="ts">
	import * as Sheet from '#lib/sheet';
	import { Bound } from '#lib/layout';
	import CollectionDetailActions from '../collection-detail-actions.svelte';
	import CollectionRecordDetail from '../collection-record-detail.svelte';
	import type { CollectionDetailPreferences } from '../collection-detail-preferences.svelte.js';
	import type {
		CollectionTableNavigationTarget,
		CollectionTableUrlNavigation
	} from '../collection-table-navigation.svelte.js';

	let {
		navigation,
		target,
		depth,
		preferences
	}: {
		navigation: CollectionTableUrlNavigation;
		target: CollectionTableNavigationTarget;
		/** Index of this frame in the URL stack; closing it truncates the stack to this length. */
		depth: number;
		preferences: CollectionDetailPreferences;
	} = $props();

	const fullScreen = $derived(preferences.isFullScreen(target.collectionName));

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
