<script lang="ts">
	import { setContext, untrack, type Snippet } from 'svelte';
	import { provideBolt, provideKinds, setUiText } from '@norbital-ai/ui';
	import { bolt } from './client.ts';
	import type { PublicBoot } from '../../protocol/public-page.ts';
	import { PUBLIC_PAGE_CONTEXT } from './context.ts';
	import { uiTextFor } from '../i18n.ts';

	let { boot, children }: { boot: PublicBoot; children: Snippet } = $props();
	const pageBoot = untrack(() => boot);
	setContext(PUBLIC_PAGE_CONTEXT, pageBoot);
	provideBolt(bolt);
	provideKinds({
		catalog: pageBoot.catalog,
		automations: pageBoot.automations,
		locale: pageBoot.workspace.locale,
		zone: pageBoot.workspace.tz,
		currency: pageBoot.workspace.currency,
		query: (collection, options) => bolt.query(collection, options),
		upload: (file, field) => bolt.upload(file, field),
		fileUrl: (ref, options) => bolt.fileUrl(ref, options)
	});
	setUiText(uiTextFor(pageBoot.workspace.locale));
</script>

{@render children()}
{#if pageBoot.visitor?.siteKey !== undefined}<div id="bolt-public-challenge"></div>{/if}
