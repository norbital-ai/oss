<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { set_ui_text, ui_text_for } from '@norbital-ai/ui';
	import type { PublicClient } from './client.ts';
	import type { PublicBoot } from '../../protocol/public-page.ts';

	// `ctx` carries the views' `ui` (`public_ui`); the page receives that same `ctx`
	let { boot, children }: { boot: PublicBoot; ctx: PublicClient; children: Snippet } =
		$props();
	const pageBoot = untrack(() => boot);
	set_ui_text(ui_text_for(pageBoot.workspace.locale));
</script>

{@render children()}
{#if pageBoot.visitor?.site_key !== undefined}<div id="bolt-public-challenge"></div>{/if}
