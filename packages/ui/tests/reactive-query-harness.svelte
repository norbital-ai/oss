<script lang="ts">
	import type { Effect, Result, Stream } from 'effect';
	import { reactive_query } from '../src/effect/index.js';
	let {
		once,
		stream
	}: { once: Effect.Effect<number, Error>; stream: Stream.Stream<Result.Result<number, Error>> } = $props();
	const query = $derived(reactive_query(once, stream));
</script>

<output>{query.current ?? 'waiting'}</output>
<span data-loading>{String(query.loading)}</span>
<span data-error>{query.error?.message ?? ''}</span>
