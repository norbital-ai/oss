<script lang="ts">
	// A custom field's `+renderer.svelte` as a template writes one: it reads the record's other fields from `view.row`.
	import type { KindView } from '../src/kinds/context.js';
	let { view }: { view: KindView } = $props();
</script>

<p data-renderer={view.mode} data-row={JSON.stringify(view.row ?? null)}>{String(view.value)}</p>
