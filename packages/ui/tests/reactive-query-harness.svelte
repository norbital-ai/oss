<script lang="ts">
	import type { Effect, Stream } from 'effect';
	import { reactiveQuery } from '../src/effect/index.js';
	let {
		once,
		stream
	}: { once: Effect.Effect<number, Error>; stream: Stream.Stream<number, Error> } = $props();
	const query = $derived(reactiveQuery(once, stream));
</script>

<output>{query.current ?? 'waiting'}</output>
<span data-loading>{String(query.loading)}</span>
<span data-error>{query.error?.message ?? ''}</span>
