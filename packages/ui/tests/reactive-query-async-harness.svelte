<script lang="ts">
	import type { Effect, Result, Stream } from 'effect';
	import { reactive_query } from '../src/effect/index.js';
	let {
		once,
		stream
	}: { once: Effect.Effect<number, Error>; stream: Stream.Stream<Result.Result<number, Error>> } = $props();
	const query = $derived(reactive_query(once, stream));
	const derivedValue = $derived(await query);
</script>

<svelte:boundary>
	<output data-derived>{derivedValue}</output>
	<output data-markup>{await query}</output>
	{#snippet pending()}<p>waiting</p>{/snippet}
</svelte:boundary>
