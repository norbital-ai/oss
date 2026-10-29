<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import type { Query, QueryAnswer } from '../src/client/contract.js';
	import { mountEdge } from '../src/effect/index.js';
	import { pageRead } from '../src/read/paging.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	let {
		of,
		read,
		index,
		after
	}: {
		of: string;
		read(limit: number, after?: string): Query<QueryAnswer>;
		index: number | null;
		after: string | null;
	} = $props();
	const page = $derived(pageRead(of, read, 25, index, after));
</script>

<output>{page.current?.rows.map((row) => row.id).join(',') ?? 'loading'}</output>
