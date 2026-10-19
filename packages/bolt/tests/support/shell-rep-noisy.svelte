<script lang="ts">
	// A representation that logs: the sweep finds it only by mounting it.
	import { untrack } from 'svelte';
	import type { RecordView } from '../../src/shell/runtime.ts';
	let { view }: { view: RecordView } = $props();
	console.error(untrack(() => `representation mounted: ${view.mode}`));
</script>

<p>{view.collection}</p>
