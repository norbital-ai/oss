<script lang="ts">
	// A representation that imports `$bolt` at module scope (read on use, after the boot).
	import type { RecordView } from '../../src/shell/runtime.ts';
	import { bolt } from '../../src/client/index.ts';
	let { view }: { view: RecordView } = $props();
</script>

<p data-rep>{bolt.org.name}: {view.mode}</p>
