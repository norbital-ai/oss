<script lang="ts">
	import type { Effect } from 'effect';
	import { untrack } from 'svelte';
	import { fork, query, type QueryOptions } from '../src/effect/index.js';
	let {
		source,
		options = {}
	}: {
		source: () => Effect.Effect<string | undefined, Error> | null;
		options?: QueryOptions<string | undefined>;
	} = $props();
	const view = query(
		() => source(),
		untrack(() => options)
	);
</script>

<output>{view.current ?? 'empty'}</output>
<span data-tag>{view.result._tag}</span>
<span data-loading>{String(view.loading)}</span>
<span data-error>{view.error?.message ?? ''}</span>
<button onclick={() => fork(view.refetch())}>Refresh</button>
