<script lang="ts">
	import { RemoteQueryResourceManager } from '$lib/ui/state/remote-query.svelte.js';

	let settleInitial!: (value: readonly string[]) => void;
	const initial = new Promise<readonly string[]>((resolve) => {
		settleInitial = resolve;
	});
	const manager = new RemoteQueryResourceManager<readonly string[]>();
	const query = manager.query('leave:first', () => initial, 'leave');
	let cacheState = $state('idle');
	let abortState = $state('idle');
	let refreshState = $state('idle');

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

	async function abortWhileUndefined(): Promise<void> {
		const aborting = new RemoteQueryResourceManager<string>();
		let loads = 0;
		const resource = aborting.query('abort-generation', (signal) => {
			loads += 1;
			if (loads === 1) {
				return new Promise<string>((_resolve, reject) => {
					signal?.addEventListener('abort', () => {
						reject(new DOMException('Aborted', 'AbortError'));
					});
				});
			}
			return new Promise<string>(() => {});
		});
		void resource.refresh();
		await Promise.resolve();
		await Promise.resolve();
		abortState =
			resource.current === undefined && resource.loading && loads === 2
				? 'loading'
				: 'cleared';
	}

	async function refreshKeepsCurrent(): Promise<void> {
		const refreshing = new RemoteQueryResourceManager<string[]>();
		let loads = 0;
		const resource = refreshing.query('cached-refresh', () => {
			loads += 1;
			if (loads === 1) return Promise.resolve(['cached']);
			return new Promise<string[]>(() => {});
		});
		await resource;
		void resource.refresh();
		const tableLoading = resource.current === undefined;
		refreshState =
			resource.current?.[0] === 'cached' && !resource.loading && !tableLoading
				? 'cached'
				: 'hidden';
	}
</script>

<p data-current={query.current === undefined ? 'unknown' : JSON.stringify(query.current)}>
	{query.loading ? 'loading' : 'settled'}
</p>
<button onclick={settle}>Settle</button>
<button onclick={() => void churnCache()}>Churn cache</button>
<button onclick={() => void abortWhileUndefined()}>Abort generation</button>
<button onclick={() => void refreshKeepsCurrent()}>Refresh cached</button>
<output data-cache>{cacheState}</output>
<output data-abort>{abortState}</output>
<output data-refresh>{refreshState}</output>
