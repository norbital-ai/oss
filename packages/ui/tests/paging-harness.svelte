<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import type { Query } from '../src/client/contract.js';
	import type { Page } from '../src/collection/types.js';
	import { mountEdge } from '../src/effect/index.js';
	import { pageRead } from '../src/read/paging.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	let {
		read,
		index,
		after
	}: {
		read(limit: number, after?: string): Query<Page>;
		index: number | null;
		after: string | null;
	} = $props();
	const page = $derived(pageRead(read, 25, index, after));
</script>

<output>{page.current?.rows.map((row) => row.id).join(',') ?? 'loading'}</output>
