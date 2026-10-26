<script lang="ts">
	// One page read awaited on the ui edge (`{#await run(bolt.query(…))}`).
	import type { Query } from '../../src/page/page-bolt.ts';
	import { run } from '../../../ui/src/effect/index.js';
	let { read }: { read: () => Query<{ rows: readonly { title: string }[] }> } = $props();
</script>

{#await run(read())}
	<p data-state="pending">…</p>
{:then page}
	<p data-state="ready">{page.rows.map((r) => r.title).join(',')}</p>
{:catch e}
	<p data-state="failed">{e instanceof Error ? e.message : 'failed'}</p>
{/await}
