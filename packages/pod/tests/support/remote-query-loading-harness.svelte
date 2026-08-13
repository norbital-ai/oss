<script lang="ts">
	import { RemoteQueryResourceManager } from '$lib/ui/state/remote-query.svelte.js';

	let settleInitial!: (value: readonly string[]) => void;
	const initial = new Promise<readonly string[]>((resolve) => {
		settleInitial = resolve;
	});
	const manager = new RemoteQueryResourceManager<readonly string[]>();
	const query = manager.query('leave:first', () => initial, 'leave');
	let cacheState = $state('idle');

	function settle(): void {
		settleInitial([]);
	}

	async function churnCache(): Promise<void> {
		const bounded = new RemoteQueryResourceManager<readonly string[]>();
		const burst = Array.from({ length: 501 }, (_value, index) =>
			bounded.query(`leave:${index}`, async () => [`company-${index}`], `leave-family:${index}`)
		);
		await Promise.all(burst);
		const reloaded = bounded.query(
			'leave:first-return',
			() => new Promise<readonly string[]>(() => undefined),
			'leave-family:0'
		);
		cacheState = reloaded.current === undefined && reloaded.loading ? 'bounded' : 'stale';
	}
</script>

<p data-current={query.current === undefined ? 'unknown' : JSON.stringify(query.current)}>
	{query.loading ? 'loading' : 'settled'}
</p>
<button onclick={settle}>Settle</button>
<button onclick={() => void churnCache()}>Churn cache</button>
<output>{cacheState}</output>
