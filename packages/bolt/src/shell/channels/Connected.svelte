<!--
	A connected channel's summary: who it answers as, through which provider, and the facts the host published (the
	webhook URL, an address, a bot). Test sends a short message where the provider can (to a handle the operator types
	when the provider names one, else to the connected account itself); Disconnect is the other verb.
-->
<script lang="ts">
	import { Button, Input } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import Facts from './Facts.svelte';
	import { aboutOf, sayOf, type ConnectProps } from './connect.ts';

	let { connection, busy, unpair, test, t, locale }: Pick<ConnectProps, 'connection' | 'busy' | 'unpair' | 't' | 'locale'> & {
		test: (to?: string) => Promise<void>;
	} = $props();
	const say = $derived(sayOf(t, locale));
	const c = $derived(connection);
	const active = $derived(c?.providers?.find((p) => p.id === c.provider));
	const provider = $derived(c?.provider === undefined ? null : active === undefined ? c.provider : say(active.label));
	const facts = $derived<(readonly [string, Json])[]>([
		...(c?.pairedAs ? [[t('Connected as'), c.pairedAs] as const] : []),
		...(provider === null ? [] : [[t('Provider'), provider] as const]),
		...Object.entries(aboutOf(c))]);
	let to = $state('');
	let tested = $state(false);
	async function send(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		tested = false;
		await test(c?.test?.to === undefined ? undefined : to.trim());
		tested = true;
	}
</script>

<section class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4" data-channel-view="connected">
	<Stack gap="xs">
		<h3 class="text-sm font-medium">{t('Setup complete')}</h3>
		<p class="text-meta">{t('This channel is live: messages to it reach the workspace, and replies go out through it.')}</p>
	</Stack>
	<Facts {facts} {t} />
	{#if c?.test !== undefined}
		<form class="flex flex-col gap-2" onsubmit={send} data-channel-test>
			{#if c.test.to !== undefined}
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-label">{say(c.test.to.label)}</span>
					<Input bind:value={to} required />
					{#if c.test.to.hint !== undefined}<span class="text-meta">{say(c.test.to.hint)}</span>{/if}
				</label>
			{/if}
			<Cluster gap="sm">
				<Button size="sm" variant="outline" type="submit" disabled={busy}>{t('Send a test message')}</Button>
				{#if tested && !busy}<span class="text-meta" aria-live="polite">{t('Test message sent')}</span>{/if}
			</Cluster>
		</form>
	{/if}
	<!-- a provider with nothing to pair (setup `none`) has nothing to disconnect -->
	{#if active?.setup.kind !== 'none'}
	<Cluster gap="sm">
		<Button size="sm" variant="ghost" class="text-destructive" disabled={busy} onclick={() => void unpair()}>{t('Disconnect')}</Button>
	</Cluster>
	{/if}
</section>
