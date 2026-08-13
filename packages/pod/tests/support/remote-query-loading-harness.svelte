<script lang="ts">
	import { RemoteQueryResourceManager } from '$lib/ui/state/remote-query.svelte.js';

	let settleInitial!: (value: readonly string[]) => void;
	const initial = new Promise<readonly string[]>((resolve) => {
		settleInitial = resolve;
	});
	const manager = new RemoteQueryResourceManager<readonly string[]>();
	const query = manager.query('leave:first', () => initial, 'leave');

	function settle(): void {
		settleInitial([]);
	}
</script>

<p data-current={query.current === undefined ? 'unknown' : JSON.stringify(query.current)}>
	{query.loading ? 'loading' : 'settled'}
</p>
<button onclick={settle}>Settle</button>
