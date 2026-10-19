<script lang="ts">
	// A representation that reads its page's create scope (the sheet mounts outside the page).
	import { getContext } from 'svelte';
	import type { RecordView } from '../../src/shell/runtime.ts';
	let { view }: { view: RecordView } = $props();
	const scope = getContext<{ title: () => string } | undefined>(Symbol.for('test.create_scope'));
</script>

<p data-scoped-rep>{view.mode}: {scope?.title() ?? 'no scope'}</p>
