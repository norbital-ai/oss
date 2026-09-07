<script lang="ts" module>
	import type { Snippet } from 'svelte';

	export type AppShellVariant = 'page' | 'full';

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
		children: Snippet;
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Bound, Cover } from '#lib/layout';
	import { getAppIdentitySlot } from './app-identity.svelte.js';

	let {
		icon,
		title,
		description,
		banner,
		thumbnail,
		variant = 'page',
		children
	}: AppShellProps = $props();
	const artwork = $derived(thumbnail ?? banner);
	// Publish identity to the shell hero above: translated titles and descriptions are not
	// statically readable, so without this the hero falls back to filename labels and icons.
	// An effect (not init assignment) so locale switches re-publish; the slot is absent when
	// the shell renders standalone in a test or story.
	const identitySlot = getAppIdentitySlot();
	$effect(() => {
		if (identitySlot) identitySlot.current = { title, description, icon, banner, thumbnail };
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
