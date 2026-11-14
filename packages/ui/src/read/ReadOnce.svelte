<script lang="ts" generics="T, E">
	import { Cause, type Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { observe_once } from '../effect/index.js';

	let { effect, pending, ready }: {
		/** The read, run once per change of it; a failure throws to the nearest boundary. */
		effect: Effect.Effect<T, E>;
		/** Shown until the read answers. */
		pending: Snippet;
		/** Shown with the read's value. */
		ready: Snippet<[T]>;
	} = $props();
	const read = observe_once(() => effect);
	const result = $derived.by(() => {
		const next = read.result;
		if (next._tag === 'Failure') throw Cause.squash(next.cause);
		return next;
	});
</script>

{#if result._tag === 'Success'}
	{@render ready(result.value)}
{:else}
	{@render pending()}
{/if}
