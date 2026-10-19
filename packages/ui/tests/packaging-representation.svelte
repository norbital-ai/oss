<script lang="ts">
	import type { RecordView } from '../src/record/types.js';
	let { view }: { view: RecordView } = $props();
</script>

<p data-representation={view.mode}>
	{view.mode === 'create' ? 'New' : String(view.record['title'])}
</p>
