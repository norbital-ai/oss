<!-- Sets an opener's contexts (ui's `carriedContexts`) above what it renders: the record sheet mounts outside the page. -->
<script lang="ts">
	import { setContext, untrack, type Snippet } from 'svelte';

	let { contexts, children }: { contexts: ReadonlyMap<unknown, unknown> | undefined; children: Snippet } = $props();
	// contexts are set once, at init: the sheet keys one mount per record
	for (const [key, value] of untrack(() => contexts) ?? []) setContext(key, value);
</script>

{@render children()}
