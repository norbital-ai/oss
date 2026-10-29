<!--
	A system page's frame: the page banner (icon, title, one line under it), the page's refusal, then its body
	in the page's one scroll owner, which holds the page edge. Models in the body are ui's `Table`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { AppHeader, Scroll } from '@norbital-ai/ui/layout';

	let {
		name,
		title,
		description,
		icon,
		banner,
		error = null,
		children
	}: {
		name: string;
		title: string;
		description?: string;
		icon?: string;
		banner?: string;
		error?: string | null;
		children: Snippet;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<AppHeader
		src={banner ?? null}
		icon={icon ?? null}
		{title}
		description={description ?? null}
		compact={narrow.current}
	/>
	<Scroll {name} layout="stack" gap="md" size="fill" inset class="py-4">
		{#if error !== null}<p
				role="alert"
				class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			>
				{error}
			</p>{/if}
		{@render children()}
	</Scroll>
</div>
