<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { provideBolt, provideKinds, setUiText } from '@norbital-ai/ui';
	import type { PublicClient } from './client.ts';
	import type { PublicBoot } from '../../protocol/public-page.ts';
	import { uiTextFor } from '../i18n.ts';

	let { boot, ctx, children }: { boot: PublicBoot; ctx: PublicClient; children: Snippet } =
		$props();
	const pageBoot = untrack(() => boot);
	provideBolt(() => ctx);
	provideKinds({
		catalog: pageBoot.catalog,
		automations: pageBoot.automations,
		locale: pageBoot.workspace.locale,
		zone: pageBoot.workspace.tz,
		currency: pageBoot.workspace.currency,
		query: (request) => ctx.query(request),
		upload: (file, field) => ctx.upload(file, field),
		file_url: (ref, options) => ctx.file_url(ref, options)
	});
	setUiText(uiTextFor(pageBoot.workspace.locale));
</script>

{@render children()}
{#if pageBoot.visitor?.siteKey !== undefined}<div id="bolt-public-challenge"></div>{/if}
