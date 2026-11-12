<script lang="ts" generics="T, E">
	import { Cause, type Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { observe_once } from '../effect/index.js';

	let { effect, pending, ready }: {
		effect: Effect.Effect<T, E>;
		pending: Snippet;
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
