<script lang="ts">
	import type { Stream } from 'effect';
	import { observe } from '../src/effect/index.js';
	let {
		source,
		seen
	}: {
		source: () => Stream.Stream<readonly number[]> | null;
		seen: (value: readonly number[] | undefined) => void;
	} = $props();
	const view = observe(() => source());
	// svelte-ignore state_referenced_locally
	view.subscribe(seen);
</script>

<output>{$view?.length ?? 'empty'}</output>
