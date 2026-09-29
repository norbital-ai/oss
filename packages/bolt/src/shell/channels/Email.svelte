<!--
	Email: nothing to pair. The host holds the receiving domain and mints an address per channel, so the component's whole
	job is to show what was minted — the address is the configuration, and an operator needs to copy it.
-->
<script lang="ts">
	import type { Json } from '../../decl/values.ts';
	import Frame from './Frame.svelte';
	import type { ConnectProps } from './connect.ts';

	let { connection, error, t }: ConnectProps = $props();
	const c = $derived(connection);
	// the host publishes what it minted under `about`; a host that publishes nothing shows the sentence alone
	const rows = $derived(Object.entries(c?.about !== null && typeof c?.about === 'object' && !Array.isArray(c?.about) ? (c?.about as Record<string, Json>) : {})
		.filter((e): e is [string, string] => typeof e[1] === 'string'));
</script>

<Frame {connection} {error} {t}>
	<p class="text-meta">{t('This host receives email for this workspace. Nothing to pair: whatever is sent to the address below lands on this channel.')}</p>
	{#if rows.length > 0}
		<dl class="flex flex-col gap-1 text-sm">
			{#each rows as [name, address] (name)}
				<div class="flex min-w-0 items-baseline gap-2">
					<dt class="shrink-0 text-meta">{name}</dt>
					<dd class="min-w-0 font-mono text-xs wrap-anywhere">{address}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</Frame>
