<!--
	Setting a channel up, drawn from the provider's own `SetupDescription`: which provider (when the transport has
	several), what to do where, the webhook URL to paste into the provider, then the form — or the QR or code the provider
	publishes while it pairs. Bolt names no provider here: a different provider is different data, so a different screen.
-->
<script lang="ts">
	import { Button, Input, Qr } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { SetupField } from '../../engine/channels/connection.ts';
	import Facts from './Facts.svelte';
	import { aboutOf, sayOf, type ConnectProps } from './connect.ts';
	import { bolt } from '../runtime.ts';

	let { connection, busy, pair, unpair, t = (key: string) => bolt.t(key), locale }: Pick<ConnectProps, 'connection' | 'busy' | 'pair' | 'unpair' | 'locale'> & { t?: ConnectProps['t'] } = $props();
	const say = $derived(sayOf(t, locale));
	const c = $derived(connection);
	const providers = $derived(c?.providers ?? []);
	/** The operator's pick; `''` is "choose again". Otherwise the host's active provider, or the only one there is. */
	let picked = $state<string | null>(null);
	const choice = $derived(providers.find((p) => p.id === (picked ?? c?.provider ?? (providers.length === 1 ? providers[0]!.id : null))));
	const webhookUrl = $derived.by(() => { const u = aboutOf(c)['webhookUrl']; return typeof u === 'string' ? u : null; });
	/** A value a step says to paste into the provider: the webhook URL, or the OAuth redirect URI. */
	const copied = (k: string): string | null => { const u = aboutOf(c)[k]; return typeof u === 'string' ? u : null; };
	const pairing = $derived(c?.pairing ?? null);
	const shown = $derived(pairing !== null && (pairing.kind === 'qr' || pairing.kind === 'code') && pairing.value !== null ? pairing : null);
	const signIn = $derived(pairing?.kind === 'oauth' && pairing.value !== null ? pairing.value : null);
	/** The provider's sign-in in a popup (a click, so no blocker stops it); this page follows the connection's stream. */
	function popup(url: string): void {
		if (window.open(url, 'bolt-oauth', 'popup,width=520,height=720') === null) window.location.assign(url);
	}
	// a provider asking mid-pairing (`form`, or a single `credential`) outranks the description's own fields
	const fields = $derived<readonly SetupField[]>(pairing?.kind === 'form' && pairing.fields !== undefined ? pairing.fields
		: pairing?.kind === 'credential' ? [{ name: 'credential', label: pairing.label ?? t('Credential'), secret: true }] : choice?.setup.fields ?? []);
	let values = $state<Record<string, string>>({});

	function submit(e: SubmitEvent): void {
		e.preventDefault();
		if (choice === undefined) return;
		const input: { [k: string]: Json } = providers.length > 1 ? { provider: choice.id } : {};
		for (const f of fields) {
			const v = (values[f.name] ?? '').trim();
			if (v !== '') input[f.name] = v;
		}
		void pair(input);
		for (const f of fields) if (f.secret === true) values[f.name] = '';
	}
</script>

<div class="flex min-w-0 flex-col gap-4" data-channel-view="setup">
	{#if providers.length === 0}
		<p class="text-meta">{t('This host offers no provider for this channel’s transport.')}</p>
	{:else if choice === undefined}
		<Stack gap="sm" data-provider-choice>
			<p class="text-sm font-medium">{t('Choose how this channel connects')}</p>
			<Stack gap="xs">
				{#each providers as p (p.id)}
					<Button variant="outline" class="justify-start" data-provider={p.id} onclick={() => { picked = p.id; values = {}; }}>{say(p.label)}</Button>
				{/each}
			</Stack>
		</Stack>
	{:else}
		{#if providers.length > 1}
			<Cluster gap="sm" justify="between" align="center">
				<p class="text-sm font-medium">{say(choice.label)}</p>
				<Button size="sm" variant="ghost" disabled={busy || c?.stored === true} onclick={() => (picked = '')}>{t('Choose another provider')}</Button>
			</Cluster>
		{/if}
		{#if choice.setup.steps.length > 0}
			<ol class="flex list-decimal flex-col gap-2 pl-5 text-sm" data-setup-steps>
				{#each choice.setup.steps as step, i (i)}
					<li class="min-w-0">
						<span>{say(step.text)}</span>
						{#if step.href !== undefined}
							<a class="ml-1 text-brand underline-offset-2 hover:underline" href={step.href} target="_blank" rel="noopener noreferrer">{t('Open')}</a>
						{/if}
						{#if step.copy !== undefined && copied(step.copy) !== null}
							<Input readonly value={copied(step.copy)} class="mt-1 font-mono text-xs wrap-anywhere" />
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
		{#if choice.setup.webhook === true && webhookUrl !== null && !choice.setup.steps.some((s) => s.copy === 'webhookUrl')}
			<Facts facts={[['webhookUrl', webhookUrl]]} {t} />
		{/if}
		{#if choice.setup.kind === 'none'}
			<Facts facts={Object.entries(aboutOf(c)).filter(([k]) => k !== 'webhookUrl')} {t} />
		{/if}

		{#if shown !== null}
			<Stack gap="xs" align="center" data-pairing={shown.kind}>
				{#if shown.kind === 'qr'}
					<Qr value={shown.value ?? ''} alt={t('Scannable code for {channel}').replace('{channel}', c?.channel ?? '')} size={220} class="rounded-md bg-white p-2" />
					<p class="max-w-sm text-center text-meta">{t('Scan this with the app on the phone this channel should answer as.')}</p>
				{:else}
					<code class="rounded-md bg-muted px-3 py-2 font-mono text-xl tracking-widest">{shown.value}</code>
					<p class="max-w-sm text-center text-meta">{t('Enter this code in the app on the phone this channel should answer as.')}</p>
				{/if}
			</Stack>
		{:else if signIn !== null}
			<Stack gap="xs" align="start" data-pairing="oauth">
				<Button size="sm" onclick={() => popup(signIn)}>{t(pairing?.label ?? 'Sign in')}</Button>
				<p class="text-meta" aria-live="polite">{t('Sign in in the window that opens; this page updates when you are done.')}</p>
			</Stack>
		{:else if c?.state === 'pairing' && (choice.setup.kind === 'qr' || choice.setup.kind === 'code')}
			<p class="text-meta" aria-live="polite">{t('The code appears when the provider publishes it.')}</p>
		{:else if choice.setup.kind !== 'none'}
			<form class="flex flex-col gap-3" onsubmit={submit} data-setup-form>
				{#each fields as f (f.name)}
					<label class="flex flex-col gap-1 text-sm">
						<span class="text-label">{say(f.label)}{#if f.optional === true} <span class="text-meta">({t('optional')})</span>{/if}</span>
						{#if f.options !== undefined}
							<!-- a choice: the first option is the default, so an untouched select sends nothing -->
							<select class="h-8 rounded-md border bg-background px-2 text-sm" name={f.name} value={values[f.name] ?? f.options[0]?.value}
								onchange={(e) => (values[f.name] = e.currentTarget.value)}>
								{#each f.options as o (o.value)}<option value={o.value}>{say(o.label)}</option>{/each}
							</select>
						{:else}
							<Input class="h-8 {f.secret === true ? 'font-mono' : ''}" name={f.name} type={f.secret === true ? 'password' : 'text'} autocomplete="off"
								required={f.optional !== true} bind:value={values[f.name]} />
						{/if}
						{#if f.hint !== undefined}<span class="text-meta">{say(f.hint)}</span>{/if}
					</label>
				{/each}
				<Cluster gap="sm">
					<Button size="sm" type="submit" disabled={busy}>{busy ? t('Pairing…') : choice.setup.kind === 'form' ? t('Connect') : t('Pair this channel')}</Button>
				</Cluster>
			</form>
		{/if}
	{/if}
	{#if c?.stored === true}
		<Cluster gap="sm">
			<Button size="sm" variant="ghost" class="text-destructive" disabled={busy} onclick={() => void unpair()}>{t('Disconnect')}</Button>
		</Cluster>
	{/if}
</div>
