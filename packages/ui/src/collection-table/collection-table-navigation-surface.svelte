<script lang="ts">
	import * as Sheet from '#lib/sheet';
	import { Bound } from '#lib/layout';
	import type { Snippet } from 'svelte';
	import CollectionDetailActions from './collection-detail-actions.svelte';
	import { CollectionDetailPreferences } from './collection-detail-preferences.svelte.js';
	import {
		CollectionTableUrlNavigation,
		setCollectionTableNavigationContext
	} from './collection-table-navigation.svelte.js';

	let {
		url,
		navigate,
		children
	}: { url: URL; navigate: (href: string) => void; children: Snippet } = $props();
	let registrationRevision = $state(0);
	const preferences = new CollectionDetailPreferences();
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => url,
		navigate: (href) => navigate(href),
		onRegistrationsChanged: () => (registrationRevision += 1)
	});
	setCollectionTableNavigationContext(navigation);
	const current = $derived(navigation.current);
	const fullScreen = $derived(current ? preferences.isFullScreen(current.collectionName) : false);
	const registration = $derived.by(() => {
		void registrationRevision;
		return navigation.resolveCurrentRegistration();
	});

	function toggleFullScreen(): void {
		if (!current) return;
		preferences.toggleFullScreen(current.collectionName);
	}
</script>

{#snippet detailActions()}
	<CollectionDetailActions
		{fullScreen}
		onToggleFullScreen={toggleFullScreen}
		onClose={() => navigation.pop()}
	/>
{/snippet}

{@render children()}

<Sheet.Root open={Boolean(current)} onOpenChange={(open) => !open && navigation.pop()}>
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
			{#if current && registration}
				{@render registration.renderDetail({ recordId: current.recordId, actions: detailActions })}
			{:else if current}
				<p class="p-5 text-sm text-muted-foreground">Record detail is unavailable.</p>
			{/if}
		</Bound>
	</Sheet.Content>
</Sheet.Root>
