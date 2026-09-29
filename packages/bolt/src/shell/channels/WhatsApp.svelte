<!--
	WhatsApp pairing: a linked-device QR the phone's camera reads, or a phone number the provider texts a code to. The
	host rotates the QR and pushes each rotation down the stream, so this draws only what it was handed and never starts a
	clock of its own — a code shown past its expiry fails on the phone with a message that blames the phone's connection.
-->
<script lang="ts">
	import { Button, Input, Qr } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import Frame from './Frame.svelte';
	import type { ConnectProps } from './connect.ts';

	let { connection, pair, unpair, busy, error, t }: ConnectProps = $props();
	let phone = $state('');
	const c = $derived(connection);
	const pairing = $derived(c?.pairing ?? null);
</script>

<Frame {connection} {error} {t}>
	{#if pairing?.kind === 'qr' && pairing.value !== null}
		<div class="flex flex-col items-center">
			<Qr value={pairing.value} alt={t('Scannable code for {channel}').replace('{channel}', connection?.channel ?? '')} size={220} class="rounded-md bg-white p-2" />
			<p class="mt-2 max-w-sm text-center text-meta">{t('Open WhatsApp on the phone this channel should answer as, then Linked devices → Link a device, and scan this.')}</p>
		</div>
	{:else if pairing?.kind === 'code' && pairing.value !== null}
		<Stack gap="xs" class="items-center">
			<code class="rounded-md bg-muted px-3 py-2 font-mono text-xl tracking-widest">{pairing.value}</code>
			<p class="text-meta">{t('Enter this code in WhatsApp → Linked devices → Link a device.')}</p>
		</Stack>
	{:else if c?.state === 'pairing'}
		<p class="text-meta" aria-live="polite">{t('The code appears when WhatsApp publishes it.')}</p>
	{/if}

	<Cluster gap="sm">
		{#if c?.state !== 'connected'}
			<form class="flex min-w-0 flex-1 flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void pair(phone.trim() === '' ? {} : { phone: phone.trim() }); }}>
				<label class="flex min-w-40 flex-1 flex-col gap-1 text-sm">
					<span class="text-meta">{t('Phone number, digits only (optional — a QR is asked for without it)')}</span>
					<Input class="h-8" inputmode="tel" placeholder={t('Country code, then the number')} bind:value={phone} />
				</label>
				<Button size="sm" type="submit" disabled={busy}>{busy ? t('Pairing…') : c?.stored === true ? t('Reconnect') : t('Pair this channel')}</Button>
			</form>
		{/if}
		{#if c?.stored === true}
			<Button size="sm" variant="ghost" class="text-destructive" disabled={busy} onclick={() => void unpair()}>{t('Unpair')}</Button>
		{/if}
	</Cluster>

	<p class="text-meta">
		{t('This links a real WhatsApp account through an unofficial client, which is against WhatsApp’s terms and accounts are sometimes banned for it — use a number the business owns and can afford to lose.')}
	</p>
	<p class="text-meta">
		{t('A paired session lives in this host’s memory. It does not survive a redeploy — reconnect here afterwards — and the host must run a single instance, or two of them will fight over the same account.')}
	</p>
</Frame>
