<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import type { Query } from '../src/client/contract.js';
	import type { Page } from '../src/model/types.js';
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
		read(limit: number, after?: string): Query<unknown>;
		index: number | null;
		after: string | null;
	} = $props();
	const page = $derived(pageRead<Page>(of, read, 25, index, after));
</script>

<output>{page.current?.rows.map((row) => row.id).join(',') ?? 'loading'}</output>
