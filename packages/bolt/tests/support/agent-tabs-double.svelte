<script lang="ts">
	import type { Snippet } from 'svelte';

	/** A Tabs double that renders every tab's content at once, so a test can read all of them. */
	let {
		config
	}: {
		config: ReadonlyArray<{ readonly name: string; readonly content?: Snippet | string }>;
	} = $props();
</script>

{#each config as tab (tab.name)}
	<section data-tab={tab.name}>
		{#if typeof tab.content === 'function'}{@render tab.content()}{:else}{tab.content}{/if}
	</section>
{/each}
