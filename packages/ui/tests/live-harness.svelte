<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import type { Live } from '../src/client/contract.js';
	import { watch } from '../src/read/live.svelte.js';
	let { source }: { source: () => Live<number> | null } = $props();
	const view = watch(() => source());
</script>

<output>{view.state.kind}:{view.value ?? 'empty'}:{view.error?.message ?? ''}</output>
