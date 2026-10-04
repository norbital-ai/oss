<!--
	One channel's connection, end to end. A `custom` channel is drawn by the workspace's own `+<name>.connect.svelte`;
	every other channel by what its host publishes: Setup while it is not connected, the Connected summary once it is.
	The two are different views on purpose — setting up asks for things, a connected channel reports what it is.
-->
<script lang="ts">
	import { aboutOf, type ConnectLoader, type ConnectProps } from './connect.ts';
	import Connected from './Connected.svelte';
	import Facts from './Facts.svelte';
	import Frame from './Frame.svelte';
	import Setup from './Setup.svelte';

	let { channel, type = channel, transport, connection, error, pair, unpair, test, busy, t, locale, workspace }: Omit<ConnectProps, 'channel'> & {
		channel: string;
		type?: string;
		/** Sends a test message through the connected channel (`connection.test` says whether and where to). */
		test: (to?: string) => Promise<void>;
		transport: string;
		/** The workspace's own `+*.connect.svelte`, by channel name. */
		workspace: Readonly<Record<string, ConnectLoader>> | undefined;
	} = $props();

	// the component is a module, so the same chunk is fetched once however often this is re-derived
	const own = $derived(transport === 'custom' ? workspace?.[type] ?? null : null);
	const chunk = $derived(own?.().then((m) => m.default) ?? null);
	// a reconnect is a connected channel catching its breath: it keeps its summary, not a setup form
	const connected = $derived(connection?.state === 'connected' || connection?.state === 'reconnecting');
	// a custom channel declaring `inbound` has its own webhook: the shell shows it, whatever the workspace's page draws
	const hook = $derived.by(() => { const u = aboutOf(connection)['webhookUrl']; return typeof u === 'string' ? u : null; });
</script>

{#if transport === 'custom'}
	{#if hook !== null}
		<div class="mb-4" data-custom-webhook><Facts facts={[['webhookUrl', hook]]} {t} /></div>
	{/if}
	{#if chunk === null}
		<p role="alert" class="text-sm text-destructive" data-custom-missing>
			{t('This custom channel has no setup screen. Add src/custom_channels/{channel}/+channel.configuration.svelte to the workspace.').replace('{channel}', channel)}
		</p>
	{:else}
		{#await chunk}
			<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
		{:then Connect}
			<Connect {channel} {connection} {error} {pair} {unpair} {busy} {t} />
		{:catch cause}
			<p role="alert" class="text-sm text-destructive">{t('This channel’s connection could not be loaded:')} {cause instanceof Error ? cause.message : String(cause)}</p>
		{/await}
	{/if}
{:else}
	<Frame {connection} {error} {t}>
		{#if connected}
			<Connected {connection} {busy} {unpair} {test} {t} {locale} />
		{:else}
			<Setup {connection} {busy} {pair} {unpair} {t} {locale} />
		{/if}
	</Frame>
{/if}
