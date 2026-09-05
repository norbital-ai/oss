<script lang="ts">
	import type { RemoteQuery } from '@norbital-ai/std/collection';
	import { untrack } from 'svelte';
	let { makeQuery }: { makeQuery: () => RemoteQuery<readonly string[]> } = $props();
	const query = $derived(makeQuery());
	const rows = $derived(query.current ?? []);
	let rendered = $state<readonly string[]>([]);
	$effect(() => {
		const value = rows;
		untrack(() => {
			rendered = value;
		});
	});
</script>

<p>{rendered.join(',')}</p>
