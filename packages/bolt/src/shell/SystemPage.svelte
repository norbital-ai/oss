<!--
	A system page's frame (staging's settings chrome): the page heading, one line under it, the page's refusal, then its
	body in the page's one scroll owner, which holds the page edge. Collections in the body are ui's `Table`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Scroll } from '@norbital-ai/ui/layout';

	let { name, title, description, error = null, children }: { name: string; title: string; description?: string; error?: string | null; children: Snippet } = $props();
</script>

<Scroll {name} layout="stack" gap="md" inset class="min-h-0 flex-1 py-4">
	<header class="flex flex-col gap-1">
		<h1 class="text-heading">{title}</h1>
		{#if description}<p class="text-meta max-w-2xl">{description}</p>{/if}
	</header>
	{#if error !== null}<p role="alert" class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>{/if}
	{@render children()}
</Scroll>
