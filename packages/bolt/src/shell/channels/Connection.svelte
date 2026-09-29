<!--
	One channel's connection, end to end: the state the host published, the pairing it asked for, and the two verbs. It owns
	nothing about any provider — `connectOf` picked the component and the component draws — so this is the same code for
	WhatsApp, for Telegram, and for a provider a workspace added last week.
-->
<script lang="ts">
	import { connectOf, type ConnectLoader, type ConnectProps } from './connect.ts';

	let { channel, transport, connection, error, pair, unpair, busy, t, workspace }: Pick<ConnectProps, 'connection' | 'error' | 'pair' | 'unpair' | 'busy' | 't'> & {
		channel: string;
		transport: string;
		/** The workspace's own `+*.connect.svelte`, by channel name. */
		workspace: Readonly<Record<string, ConnectLoader>> | undefined;
	} = $props();

	// the component is a module, so the same chunk is fetched once however often this is re-derived
	const chunk = $derived(connectOf(channel, transport, workspace)?.().then((m) => m.default) ?? null);
</script>

{#if chunk === null}
	<p class="text-sm text-muted-foreground">{t('The host provisions this channel with the workspace; nothing to pair.')}</p>
{:else}
	{#await chunk}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:then Connect}
		<Connect {channel} {connection} {error} {pair} {unpair} {busy} {t} />
	{:catch cause}
		<p role="alert" class="text-sm text-destructive">{t('This channel’s connection could not be loaded:')} {cause instanceof Error ? cause.message : String(cause)}</p>
	{/await}
{/if}
