<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { provide_bolt, provide_kinds, set_ui_text, ui_text_for, type ViewBolt } from '@norbital-ai/ui';
	import type { PublicClient } from './client.ts';
	import type { PublicBoot } from '../../protocol/public-page.ts';

	let { boot, ctx, views, children }: { boot: PublicBoot; ctx: PublicClient; views: ViewBolt; children: Snippet } =
		$props();
	const pageBoot = untrack(() => boot);
	provide_bolt(() => views);
	provide_kinds({
		catalog: pageBoot.catalog,
		automations: pageBoot.automations,
		locale: pageBoot.workspace.locale,
		zone: pageBoot.workspace.tz,
		currency: pageBoot.workspace.currency,
		query: (request) => views.query(request),
		upload: (file, field) => ctx.upload(file, field),
		file_url: (ref, options) => ctx.file_url(ref, options)
	});
	set_ui_text(ui_text_for(pageBoot.workspace.locale));
</script>

{@render children()}
{#if pageBoot.visitor?.site_key !== undefined}<div id="bolt-public-challenge"></div>{/if}
