<script lang="ts">
	import type { Effect, Stream } from 'effect';
	import { reactiveQuery } from '../src/effect/index.js';
	let {
		once,
		stream
	}: { once: Effect.Effect<number, Error>; stream: Stream.Stream<number, Error> } = $props();
	const query = $derived(reactiveQuery(once, stream));
	const derivedValue = $derived(await query);
</script>

<svelte:boundary>
	<output data-derived>{derivedValue}</output>
	<output data-markup>{await query}</output>
	{#snippet pending()}<p>waiting</p>{/snippet}
</svelte:boundary>
