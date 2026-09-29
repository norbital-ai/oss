<!--
	Telegram pairing: a bot token from BotFather. The host seals it and points the bot at this host, so nothing else is
	configurable here — a token, and whether the bot is answering.
-->
<script lang="ts">
	import { Button, Input } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import Frame from './Frame.svelte';
	import type { ConnectProps } from './connect.ts';

	let { connection, pair, unpair, busy, error, t }: ConnectProps = $props();
	let token = $state('');
	const c = $derived(connection);
</script>

<Frame {connection} {error} {t}>
	<form class="flex flex-wrap items-end gap-2" onsubmit={(e) => { e.preventDefault(); void pair({ token: token.trim() }); token = ''; }}>
		<label class="flex min-w-40 flex-1 flex-col gap-1 text-sm">
			<span class="text-meta">{t('Bot token')}</span>
			<Input class="h-8 font-mono" type="password" autocomplete="off" required placeholder={t('123456789:AA…')} bind:value={token} />
		</label>
		<Button size="sm" type="submit" disabled={token.trim() === '' || busy}>{busy ? t('Registering…') : c?.stored === true ? t('Replace the token') : t('Connect the bot')}</Button>
	</form>
	<Stack gap="xs">
		<p class="text-meta">{t('Create a bot with BotFather (/newbot) and paste its token. The host seals it and points the bot at this host.')}</p>
		{#if c?.stored === true}
			<Button size="sm" variant="ghost" class="self-start text-destructive" disabled={busy} onclick={() => void unpair()}>{t('Disconnect')}</Button>
		{/if}
	</Stack>
</Frame>
