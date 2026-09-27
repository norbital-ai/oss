<!--
@component
An app page's shell: the hero (icon, title, description, banner), header actions, and the page body in the shared inset.
Every `+<page>.page.svelte` renders inside one.
@example
<AppShell icon="lucide:briefcase" title={bolt.t('jobs.title')} description={bolt.t('jobs.description')}>
	<Table of="jobs" />
</AppShell>
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** `page` wraps the body in the shared inset; `full` leaves it edge to edge (tab strips, full-bleed surfaces). */
	export type AppShellVariant = 'page' | 'full';

	/** The props of `AppShell`. */
	export interface AppShellProps {
		/** Icon name rendered in the workspace hero (for example `lucide:cpu`). */
		icon: string;
		/** Page title rendered in the workspace hero and the document head. */
		title: string;
		/** Page description rendered under the hero title. */
		description: string;
		/** Banner artwork for the hero background and, unless overridden, the app thumbnail. */
		banner?: string;
		/** App card artwork. Defaults to the banner. */
		thumbnail?: string;
		/**
		 * `page` (default) wraps content in the shared inset region so it aligns with the
		 * hero icon leading edge; `full` skips the wrapper for tab strips (which carry their
		 * own matching inset) and full-bleed surfaces.
		 */
		variant?: AppShellVariant;
		/** Header actions the shell places beside the hero title (today's `AppHeaderActions`). */
		actions?: Snippet;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { getAllContexts, onDestroy } from 'svelte';
	import { offerContexts } from '../views/bolt.js';
	import Bound from './bound.svelte';
	import Cover from './cover.svelte';
	import { getAppIdentitySlot } from './app-identity.svelte.js';
	// the page's contexts (its create scope), for a record sheet opened over it by the URL: any collection's (`pageContexts`)
	onDestroy(offerContexts('*', getAllContexts()));

	let {
		icon,
		title,
		description,
		banner,
		thumbnail,
		variant = 'page',
		actions,
		children
	}: AppShellProps = $props();
	const artwork = $derived(thumbnail ?? banner);
	// Publish identity to the shell hero above: translated titles and descriptions are not
	// statically readable, so without this the hero falls back to filename labels and icons.
	// An effect (not init assignment) so locale switches re-publish; the slot is absent when
	// the shell renders standalone in a test or story.
	const identitySlot = getAppIdentitySlot();
	$effect(() => {
		if (identitySlot) identitySlot.current = { title, description, icon, banner, thumbnail, actions };
	});
	onDestroy(() => {
		if (identitySlot?.current?.title === title) identitySlot.current = null;
	});
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<meta name="bolt:icon" content={icon} />
	{#if artwork != null}
		<meta name="bolt:thumbnail" content={artwork} />
	{/if}
	{#if banner != null}
		<meta name="bolt:banner" content={banner} />
	{/if}
</svelte:head>

<!--
	Every Layout composition: a Cover whose body is a Box carrying the page inset. The inset
	token is the same one the hero uses, so content aligns with the hero icon leading edge by
	construction — authored apps never set outer padding themselves. Spacing between regions
	belongs to the parent (Stack gap / Cover gap), never margins on the content.
-->
<Cover>
	{#if variant === 'page'}
		<Bound size="full" inset>
			{@render children()}
		</Bound>
	{:else}
		{@render children()}
	{/if}
</Cover>
