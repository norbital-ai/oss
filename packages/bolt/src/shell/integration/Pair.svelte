<!--
	Pairing an instance, drawn from the provider's own `SetupDescription`: which provider (when the driver has several),
	what to do where, the webhook URL to paste into the provider, then the fields and Connect — or the QR or code the
	provider publishes while it pairs (its fields one click away), or its OAuth sign-in in the window the click reserved. Bolt names no provider here: a different provider is
	different data, so a different screen. Secrets are masked and cleared once sent; nothing stored is shown back.
-->
<script lang="ts">
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, Combobox, Input, Qr } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { ImportStartInput, SetupField } from '../../protocol/instance-status.ts';
	import { watch } from 'runed';
	import Facts from './Facts.svelte';
	import ImportStart from './ImportStart.svelte';
	import { importStartDraft, validImportStart } from './import-start.ts';
	import { aboutOf, reserveSignIn, sayOf, signInTo, type IntegrationSetupProps } from './setup.ts';

	let {
		status,
		error,
		busy,
		pair,
		unpair,
		cancel,
		controls = true,
		t,
		locale
	}: Pick<
		IntegrationSetupProps,
		'status' | 'error' | 'busy' | 'pair' | 'unpair' | 't' | 'locale'
	> & {
		/** Reconnecting a connected instance: back to its summary without pairing. */
		cancel?: (() => void) | undefined;
		controls?: boolean | undefined;
	} = $props();
	const say = $derived(sayOf(t, locale));
	const c = $derived(status);
	const retry = $derived(c?.state === 'error' || error !== null);
	const providers = $derived(c?.providers ?? []);
	/** The operator's pick; `''` is "choose again". Otherwise the host's active provider, or the only one there is. */
	let picked = $state<string | null>(null);
	const choice = $derived(
		providers.find(
			(p) => p.id === (picked ?? c?.provider ?? (providers.length === 1 ? providers[0]!.id : null))
		)
	);
	let boundary = $state<ImportStartInput | undefined>(undefined);
	const draft = $derived(
		choice === undefined ? undefined : (boundary ?? importStartDraft(c?.importStart, choice))
	);
	const valid = $derived(
		choice === undefined || draft === undefined || validImportStart(draft, choice)
	);
	watch(
		() => choice?.id,
		() => {
			boundary = undefined;
		}
	);
	watch(
		() => JSON.stringify(c?.importStart ?? null),
		(current, previous) => {
			if (previous !== undefined && current !== previous) boundary = undefined;
		}
	);
	const webhookUrl = $derived.by(() => {
		const u = aboutOf(c)['webhookUrl'];
		return typeof u === 'string' ? u : null;
	});
	/** A value a step says to paste into the provider: the webhook URL, or the OAuth redirect URI. */
	const copied = (k: string): string | null => {
		const u = aboutOf(c)[k];
		return typeof u === 'string' ? u : null;
	};
	const pairing = $derived(c?.pairing ?? null);
	const shown = $derived(
		c?.state !== 'error' &&
			pairing !== null &&
			(pairing.kind === 'qr' || pairing.kind === 'code') &&
			pairing.value !== null
			? pairing
			: null
	);
	const signIn = $derived(
		c?.state !== 'error' && pairing?.kind === 'oauth' && pairing.value !== null
			? pairing.value
			: null
	);
	/** The provider's sign-in in a popup (a click, so no blocker stops it); this page follows the instance's stream. */
	function popup(url: string): void {
		if (window.open(url, 'bolt-oauth', 'popup,width=520,height=720') === null)
			window.location.assign(url);
	}
	// the click that started this pairing reserved the sign-in window: it follows the provider's URL as soon as it arrives
	watch(
		() => signIn,
		(url) => {
			if (url !== null) signInTo(url);
		}
	);
	/** Starts a pairing that takes nothing (a sign-in, a QR): the provider then publishes what to show. */
	function start(): void {
		if (choice === undefined || !valid) return;
		if (choice.setup.kind === 'oauth') reserveSignIn();
		fork(
			pair({
				...(providers.length > 1 ? { provider: choice.id } : {}),
				...(choice.importStart !== undefined && boundary !== undefined
					? { importStart: boundary }
					: {})
			})
		);
	}
	const waiting = $derived(c?.state === 'pairing' || c?.state === 'connecting');
	// a provider asking mid-pairing (`form`, or a single `credential`) outranks the description's own fields
	const fields = $derived<readonly SetupField[]>(
		pairing?.kind === 'form' && pairing.fields !== undefined
			? pairing.fields
			: pairing?.kind === 'credential'
				? [{ name: 'credential', label: pairing.label ?? t('Credential'), secret: true }]
				: (choice?.setup.fields ?? [])
	);
	let values = $state<Record<string, string>>({});

	function submit(e: SubmitEvent): void {
		e.preventDefault();
		if (choice === undefined || !valid) return;
		const input: { [k: string]: Json } = providers.length > 1 ? { provider: choice.id } : {};
		if (choice.importStart !== undefined && boundary !== undefined) input.importStart = boundary;
		for (const f of fields) {
			const v = (values[f.name] ?? '').trim();
			if (v !== '') input[f.name] = v;
		}
		fork(pair(input));
		for (const f of fields) if (f.secret === true) values[f.name] = '';
	}
</script>

{#snippet form()}
	<form class="flex flex-col gap-3" onsubmit={submit} data-setup-form>
		{#each fields as f (f.name)}
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-label"
					>{say(f.label)}{#if f.optional === true}
						<span class="text-meta">({t('optional')})</span>{/if}</span
				>
				{#if f.options !== undefined}
					<!-- a choice: the first option is the default, so an untouched control sends nothing -->
					<Combobox
						size="sm"
						aria-label={say(f.label)}
						value={values[f.name] ?? f.options[0]?.value ?? null}
						onChange={(v) => {
							if (v !== null) values[f.name] = v;
						}}
						options={f.options.map((o) => ({ value: o.value, label: say(o.label) }))}
					/>
				{:else}
					<Input
						class="h-8 {f.secret === true ? 'font-mono' : ''}"
						name={f.name}
						type={f.secret === true ? 'password' : 'text'}
						autocomplete="off"
						required={f.optional !== true}
						bind:value={values[f.name]}
					/>
				{/if}
				{#if f.hint !== undefined}<span class="text-meta">{say(f.hint)}</span>{/if}
			</label>
		{/each}
		<Cluster gap="sm">
			<Button
				size="sm"
				type="submit"
				disabled={busy || !valid}
				data-connect={retry ? '' : undefined}
				>{busy ? t('Connecting…') : retry ? t('Try again') : t('Connect')}</Button
			>
			{#if cancel !== undefined}<Button size="sm" variant="ghost" disabled={busy} onclick={cancel}
					>{t('Cancel')}</Button
				>{/if}
		</Cluster>
	</form>
{/snippet}

<div class="flex min-w-0 flex-col gap-4" data-setup-view="pair">
	{#if c !== null && providers.length === 0}
		<p class="text-meta">{t('This host offers no provider for this integration’s driver.')}</p>
	{:else if c !== null && choice === undefined && c.state !== 'connecting'}
		<Stack gap="sm" data-provider-choice>
			<p class="text-sm font-medium">{t('Choose how this integration connects')}</p>
			<Stack gap="xs">
				{#each providers as p (p.id)}
					<Button
						variant="outline"
						class="justify-start"
						data-provider={p.id}
						disabled={p.available === false}
						title={p.available === false ? t('Not available on this host') : undefined}
						onclick={() => {
							picked = p.id;
							values = {};
						}}>{say(p.label)}</Button
					>
				{/each}
			</Stack>
		</Stack>
	{:else if choice !== undefined && c?.state !== 'connecting'}
		{#if choice.importStart !== undefined && draft !== undefined && !waiting && shown === null && signIn === null}
			<ImportStart
				provider={choice}
				value={draft}
				onChange={(value) => (boundary = value)}
				{busy}
				{t}
				{locale}
			/>
		{/if}
		{#if providers.length > 1}
			<Cluster gap="sm" justify="between" align="center">
				<p class="text-sm font-medium">{say(choice.label)}</p>
				<Button
					size="sm"
					variant="ghost"
					disabled={busy || c?.stored === true}
					onclick={() => (picked = '')}>{t('Choose another provider')}</Button
				>
			</Cluster>
		{/if}
		{#if choice.setup.steps.length > 0}
			<ol class="flex list-decimal flex-col gap-2 pl-5 text-sm" data-setup-steps>
				{#each choice.setup.steps as step, i (i)}
					<li class="min-w-0">
						<span>{say(step.text)}</span>
						{#if step.href !== undefined}
							<a
								class="ml-1 text-brand underline-offset-2 hover:underline"
								href={step.href}
								target="_blank"
								rel="noopener noreferrer">{t('Open')}</a
							>
						{/if}
						{#if step.copy !== undefined && copied(step.copy) !== null}
							<Input
								readonly
								value={copied(step.copy)}
								class="mt-1 font-mono text-xs wrap-anywhere"
							/>
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
					<Qr
						value={shown.value ?? ''}
						alt={t('Scannable code for {instance}').replace('{instance}', c?.instance ?? '')}
						size={220}
						class="rounded-md bg-white p-2"
					/>
					<p class="max-w-sm text-center text-meta">
						{t('Scan this with the app on the phone this instance should answer as.')}
					</p>
				{:else}
					<code class="rounded-md bg-muted px-3 py-2 font-mono text-xl tracking-widest"
						>{shown.value}</code
					>
					<p class="max-w-sm text-center text-meta">
						{t('Enter this code in the app on the phone this instance should answer as.')}
					</p>
				{/if}
			</Stack>
			{#if (choice.setup.kind === 'qr' || choice.setup.kind === 'code') && (choice.setup.fields ?? []).length > 0}
				<!-- the QR is the way in; its fields (a phone number, for a code instead) stay one click away -->
				<details class="text-sm" data-pairing-alternative>
					<summary class="cursor-pointer text-meta">{t('Use a phone number instead')}</summary>
					<div class="pt-2">{@render form()}</div>
				</details>
			{/if}
		{:else if signIn !== null}
			<Stack gap="xs" align="start" data-pairing="oauth">
				<Button
					size="sm"
					href={signIn}
					target="_blank"
					rel="noopener noreferrer"
					onclick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						popup(signIn);
					}}>{t(pairing?.label ?? 'Sign in')}</Button
				>
				<p class="text-meta" aria-live="polite">
					{t('Sign in in the window that opens; this page updates when you are done.')}
				</p>
			</Stack>
		{:else if waiting && (choice.setup.kind === 'qr' || choice.setup.kind === 'code' || choice.setup.kind === 'oauth')}
			<p class="text-meta" aria-live="polite">
				{choice.setup.kind === 'oauth'
					? t('Opening the sign-in…')
					: t('The code appears when the provider publishes it.')}
			</p>
		{:else if choice.setup.kind === 'oauth'}
			<Cluster gap="sm">
				<Button
					size="sm"
					disabled={busy || !valid}
					onclick={start}
					data-sign-in
					data-connect={retry ? '' : undefined}>{retry ? t('Try again') : say(choice.label)}</Button
				>
				{#if cancel !== undefined}<Button size="sm" variant="ghost" disabled={busy} onclick={cancel}
						>{t('Cancel')}</Button
					>{/if}
			</Cluster>
		{:else if choice.setup.kind !== 'none'}
			{@render form()}
		{/if}
	{/if}
	{#if controls && c?.stored === true && cancel === undefined}
		<Cluster gap="sm">
			<Button
				size="sm"
				variant="ghost"
				class="text-destructive"
				disabled={busy}
				onclick={() => fork(unpair())}>{t('Disconnect')}</Button
			>
		</Cluster>
	{/if}
</div>
