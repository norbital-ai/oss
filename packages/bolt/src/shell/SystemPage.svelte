<!--
	A system page's frame: the page banner (icon, title, one line under it), the page's refusal, then its body.
	When `bounded` is true, the body fills the remaining viewport height without an outer scroll wrapper so
	nested tabs, tables, record shells and canvases scroll inside themselves.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { AppHeader, Bound, Scroll } from '@norbital-ai/ui/layout';

	let {
		name,
		title,
		description,
		icon,
		banner,
		error = null,
		bounded = false,
		children
	}: {
		name: string;
		title: string;
		description?: string;
		icon?: string;
		banner?: string;
		error?: string | null;
		bounded?: boolean;
		children: Snippet;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<!-- a phone's top bar already names the page -->
	{#if !narrow.current}
		<AppHeader src={banner ?? null} icon={icon ?? null} {title} description={description ?? null} />
	{/if}
	{#if bounded}
		<Bound inset size="fill" clip class="flex flex-col gap-3 py-4">
			{#if error !== null}<p
					role="alert"
					class="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					{error}
				</p>{/if}
			<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
				{@render children()}
			</div>
		</Bound>
	{:else}
		<Scroll {name} layout="stack" gap="md" size="fill" inset class="py-4">
			{#if error !== null}<p
					role="alert"
					class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					{error}
				</p>{/if}
			{@render children()}
		</Scroll>
	{/if}
</div>
