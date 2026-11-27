<!--
	Pairing an instance, drawn from the provider's own `SetupDescription`: which provider (when the driver has several),
	what to do where, the webhook URL to paste into the provider, then the fields and Connect — or the QR or code the
	provider publishes while it pairs (its fields one click away), or its OAuth sign-in in the window the click reserved. Bolt names no provider here: a different provider is
	different data, so a different screen. Secrets are masked and cleared once sent; nothing stored is shown back.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { everySecond } from '../seconds.ts';
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Badge, Button, Combobox, confirm_action, Icon, Input, Qr, Spinner } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { ImportStartInput, SetupField } from '@norbital-ai/host-api';
	import { watch } from '@norbital-ai/ui/behaviors';
	import Facts from './Facts.svelte';
	import ImportStart from './ImportStart.svelte';
	import { importStartDraft, validImportStart } from './import-start.ts';
	import { aboutOf, driverIcon, reserveSignIn, sayOf, signInTo, type IntegrationSetupProps } from './setup.ts';

	let {
		status,
		error,
		busy,
		pair,
		unpair,
		cancel,
		controls = true,
		on_footer,
		t,
		locale
	}: Pick<
		IntegrationSetupProps,
		'status' | 'error' | 'busy' | 'pair' | 'unpair' | 't' | 'locale'
	> & {
		/** Reconnecting a connected instance: back to its summary without pairing. */
		cancel?: (() => void) | undefined;
		controls?: boolean | undefined;
		/** When hosted inside a Sheet, hands the pairing actions to the Sheet's pinned footer instead of drawing them inline. */
		on_footer?: ((footer: Snippet | null) => void) | undefined;
	} = $props();
	const pairUid = $props.id();
	const formId = `bolt-pair-form-${pairUid}`;
	const say = $derived(sayOf(t, locale));
	const c = $derived(status);
	const retry = $derived(c?.state === 'error' || error !== null);
	const providers = $derived(c?.providers ?? []);
	/** Past this many a list is searched, not scanned. */
	const MANY = 8;
	let search = $state('');
	const listed = $derived(
		providers.filter((p) =>
			say(p.name ?? p.label)
				.toLowerCase()
				.includes(search.trim().toLowerCase())
		)
	);
	/** The operator's pick; `''` is "choose again". Otherwise the host's active provider, or the only one there is. */
	let picked = $state<string | null>(null);
	const choice = $derived(
		providers.find(
			(p) => p.id === (picked ?? c?.provider ?? (providers.length === 1 ? providers[0]?.id : null))
		)
	);
	let boundary = $state<ImportStartInput | undefined>(undefined);
	const draft = $derived(
		choice === undefined ? undefined : (boundary ?? importStartDraft(c?.import_start, choice))
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
		() => JSON.stringify(c?.import_start ?? null),
		(current, previous) => {
			if (previous !== undefined && current !== previous) boundary = undefined;
		}
	);
	const webhook_url = $derived.by(() => {
		const u = aboutOf(c)['webhook_url'];
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
	// the code's own deadline, counted down; past it the code is refused, so the page offers a fresh one
	let now = $state(Date.now());
	const expiresAt = $derived(shown?.expires_at === undefined ? null : Date.parse(shown.expires_at));
	watch(
		() => expiresAt,
		(deadline) => {
			if (deadline === null || Number.isNaN(deadline)) return;
			now = Date.now();
			return everySecond((at) => (now = at));
		}
	);
	const left = $derived(
		expiresAt === null || Number.isNaN(expiresAt)
			? null
			: Math.max(0, Math.ceil((expiresAt - now) / 1000))
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
				...(choice.import_start !== undefined && boundary !== undefined
					? { import_start: boundary }
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
		if (choice.import_start !== undefined && boundary !== undefined) input.import_start = boundary;
		for (const f of fields) {
			const v = (values[f.name] ?? '').trim();
			if (v !== '') input[f.name] = v;
		}
		fork(pair(input));
		for (const f of fields) if (f.secret === true) values[f.name] = '';
	}

	const hasFooter = $derived(
		choice !== undefined &&
			c?.state !== 'connecting' &&
			(shown !== null ||
				signIn !== null ||
				(!waiting && choice.setup.kind !== 'none') ||
				(providers.length > 1 && c?.stored !== true && !waiting) ||
				cancel !== undefined)
	);
	$effect(() => {
		if (on_footer === undefined) return;
		on_footer(hasFooter ? sheetFooter : null);
		return () => on_footer(null);
	});
</script>

{#snippet sheetFooter()}
	{#if choice !== undefined && c?.state !== 'connecting'}
		<Cluster gap="sm" align="center">
			{#if providers.length > 1 && c?.stored !== true && shown === null && signIn === null && !waiting}
				<Button variant="ghost" disabled={busy} onclick={() => (picked = '')}>
					{t('Choose another provider')}
				</Button>
			{/if}
			{#if cancel !== undefined}
				<Button variant="ghost" disabled={busy} onclick={cancel}>{t('Cancel')}</Button>
			{/if}
			{#if shown !== null}
				<Button
					variant={left === 0 ? 'default' : 'outline'}
					disabled={busy}
					onclick={start}
					data-pairing-refresh
				>
					{t('Get a new code')}
				</Button>
			{:else if signIn !== null}
				<Button
					href={signIn}
					target="_blank"
					rel="noopener noreferrer"
					onclick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
						event.preventDefault();
						popup(signIn);
					}}
				>
					{t(pairing?.label ?? 'Sign in')}
				</Button>
			{:else if choice.setup.kind === 'oauth' && !waiting}
				<Button
					disabled={busy || !valid}
					onclick={start}
					data-sign-in
					data-connect={retry ? '' : undefined}
				>
					{retry ? t('Try again') : say(choice.label)}
				</Button>
			{:else if !waiting && choice.setup.kind !== 'none'}
				<Button
					type="submit"
					form={formId}
					disabled={busy || !valid}
					data-connect={retry ? '' : undefined}
				>
					{busy ? t('Connecting…') : retry ? t('Try again') : t('Connect')}
				</Button>
			{/if}
		</Cluster>
	{/if}
{/snippet}

{#snippet form(inlineSubmit: boolean)}
	<form
		id={inlineSubmit ? undefined : formId}
		class="flex flex-col gap-3"
		onsubmit={submit}
		data-setup-form
	>
		{#each fields as f (f.name)}
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-label"
					>{say(f.label)}{#if f.optional === true}{' '}<span class="text-meta">({t('optional')})</span
						>{/if}</span
				>
				{#if f.options !== undefined}
					<!-- a choice: the first option is the default, so an untouched control sends nothing -->
					<Combobox
						aria-label={say(f.label)}
						value={values[f.name] ?? f.options[0]?.value ?? null}
						on_change={(v) => {
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
		{#if inlineSubmit}
			<Cluster gap="sm">
				<Button type="submit" disabled={busy || !valid} data-connect={retry ? '' : undefined}
					>{busy ? t('Connecting…') : retry ? t('Try again') : t('Connect')}</Button
				>
				{#if cancel !== undefined}<Button variant="ghost" disabled={busy} onclick={cancel}
						>{t('Cancel')}</Button
					>{/if}
			</Cluster>
		{/if}
	</form>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4" data-setup-view="pair">
	{#if c !== null && providers.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center py-8 text-center">
			<p class="max-w-sm text-meta">{t('This host offers no provider for this integration’s driver.')}</p>
		</div>
	{:else if c !== null && choice === undefined && c.state !== 'connecting'}
		<Stack gap="md" data-provider-choice>
			<Stack gap="xs">
				<p class="text-sm font-medium text-foreground">{t('Choose how this integration connects')}</p>
				<p class="text-meta">{t('Select a provider to configure credentials or pair an account.')}</p>
			</Stack>
			<Stack gap="sm">
				{#if providers.length > MANY}
					<Input
						type="search"
						placeholder={t('Search platforms')}
						aria-label={t('Search platforms')}
						bind:value={search}
						data-provider-search
					/>
				{/if}
				{#each listed as p (p.id)}
					<button
						type="button"
						class="group flex w-full items-center gap-3.5 rounded-control border border-border-control bg-surface-subtle px-4 py-3.5 text-left transition-colors outline-hidden hover:border-border-active hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
						data-provider={p.id}
						disabled={p.available === false}
						title={p.available === false ? t('Not available on this host') : undefined}
						onclick={() => {
							picked = p.id;
							values = {};
						}}
					>
						<span class="grid size-10 shrink-0 place-items-center rounded-control border border-border bg-background">
							<Icon name={p.icon ?? driverIcon(c.driver)} class="size-5" />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex flex-wrap items-center gap-2">
								<span class="truncate text-sm font-medium text-foreground">{say(p.name ?? p.label)}</span>
								{#if p.name !== undefined}
									<Badge variant="outline" data-provider-maintainer>{say(p.label)}</Badge>
								{/if}
							</span>
							{#if p.available === false}
								<span class="mt-0.5 block text-meta">{t('Not available on this host')}</span>
							{:else if p.description !== undefined}
								<span class="mt-0.5 line-clamp-2 block text-meta">{say(p.description)}</span>
							{/if}
						</span>
						<Icon
							name="lucide:chevron-right"
							class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
						/>
					</button>
				{/each}
			</Stack>
		</Stack>
	{:else if choice !== undefined && c?.state !== 'connecting'}
		{#if providers.length > 1}
			<Cluster gap="sm" justify="between" align="center" class="rounded-control border border-border bg-surface-subtle px-3.5 py-2.5">
				<span class="flex min-w-0 items-center gap-2.5">
					<span class="grid size-7 shrink-0 place-items-center rounded-control border border-border bg-background">
						<Icon name={choice.icon ?? driverIcon(c?.driver ?? '')} class="size-4" />
					</span>
					<span class="min-w-0 truncate text-sm font-medium text-foreground">
						{say(choice.name ?? choice.label)}
					</span>
					{#if choice.name !== undefined}
						<Badge variant="outline">{say(choice.label)}</Badge>
					{/if}
				</span>
				{#if on_footer === undefined}
					<Button variant="ghost" disabled={busy || c?.stored === true} onclick={() => (picked = '')}
						>{t('Choose another provider')}</Button
					>
				{/if}
			</Cluster>
		{/if}
		{#if choice.import_start !== undefined && draft !== undefined && !waiting && shown === null && signIn === null}
			<ImportStart
				provider={choice}
				value={draft}
				on_change={(value) => (boundary = value)}
				{busy}
				{t}
				{locale}
			/>
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
		{#if choice.setup.webhook === true && webhook_url !== null && !choice.setup.steps.some((s) => s.copy === 'webhook_url')}
			<Facts facts={[['webhook_url', webhook_url]]} {t} />
		{/if}
		{#if choice.setup.kind === 'none'}
			<Facts facts={Object.entries(aboutOf(c)).filter(([k]) => k !== 'webhook_url')} {t} />
		{/if}

		{#if shown !== null}
			<div
				class="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center"
				data-pairing={shown.kind}
			>
				{#if left === 0}
					<p class="text-sm font-medium text-foreground" role="status" data-pairing-expired>
						{t('This code expired.')}
					</p>
				{:else if shown.kind === 'qr'}
					<!-- Scanners need a white quiet zone, so the code stays on paper in both themes. -->
					<Qr
						value={shown.value ?? ''}
						alt={t('Scannable code for {instance}').replace('{instance}', c?.instance ?? '')}
						size={220}
						class="rounded-md bg-white p-2.5 shadow-xs"
					/>
					<p class="max-w-sm text-center text-meta">
						{t('Scan this with the app on the phone this instance should answer as.')}
					</p>
				{:else}
					<code class="rounded-md border border-border bg-muted px-4 py-2.5 font-mono text-xl tracking-widest"
						>{shown.value}</code
					>
					<p class="max-w-sm text-center text-meta">
						{t('Enter this code in the app on the phone this instance should answer as.')}
					</p>
				{/if}
				{#if left !== null && left > 0}<p class="text-meta tabular-nums" data-pairing-expiry>
						{t('Expires in {n}s').replace('{n}', String(left))}
					</p>{/if}
				{#if on_footer === undefined}
					<Button
						variant={left === 0 ? 'default' : 'ghost'}
						disabled={busy}
						onclick={start}
						data-pairing-refresh>{t('Get a new code')}</Button
					>
				{/if}
			</div>
			{#if (choice.setup.kind === 'qr' || choice.setup.kind === 'code') && (choice.setup.fields ?? []).length > 0}
				<!-- the QR is the way in; its fields (a phone number, for a code instead) stay one click away -->
				<details class="rounded-control border border-border bg-surface-subtle px-3.5 py-2.5 text-sm" data-pairing-alternative>
					<summary class="cursor-pointer text-meta">{t('Use a phone number instead')}</summary>
					<div class="pt-3">{@render form(true)}</div>
				</details>
			{/if}
		{:else if signIn !== null}
			<div class="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center" data-pairing="oauth">
				{#if on_footer === undefined}
					<Button
						href={signIn}
						target="_blank"
						rel="noopener noreferrer"
						onclick={(event) => {
							if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
							event.preventDefault();
							popup(signIn);
						}}>{t(pairing?.label ?? 'Sign in')}</Button
					>
				{/if}
				<p class="max-w-sm text-meta" aria-live="polite">
					{t('Sign in in the window that opens; this page updates when you are done.')}
				</p>
			</div>
		{:else if waiting && (choice.setup.kind === 'qr' || choice.setup.kind === 'code' || choice.setup.kind === 'oauth')}
			<div class="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center" role="status" aria-live="polite">
				<Spinner class="size-5 text-muted-foreground" />
				<p class="max-w-sm text-meta">
					{choice.setup.kind === 'oauth'
						? t('Opening the sign-in…')
						: t('The code appears when the provider publishes it.')}
				</p>
			</div>
		{:else if choice.setup.kind === 'oauth'}
			{#if on_footer === undefined}
				<Cluster gap="sm">
					<Button
						disabled={busy || !valid}
						onclick={start}
						data-sign-in
						data-connect={retry ? '' : undefined}>{retry ? t('Try again') : say(choice.label)}</Button
					>
					{#if cancel !== undefined}<Button variant="ghost" disabled={busy} onclick={cancel}
							>{t('Cancel')}</Button
						>{/if}
				</Cluster>
			{:else}
				<div class="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
					<p class="max-w-sm text-meta">
						{t('Continue below to sign in and authorize this account.')}
					</p>
				</div>
			{/if}
		{:else if choice.setup.kind !== 'none'}
			{@render form(on_footer === undefined)}
		{/if}
	{/if}
	{#if controls && c?.stored === true && cancel === undefined}
		<Cluster gap="sm">
			<Button
				variant="ghost"
				class="text-destructive"
				disabled={busy}
				data-disconnect
				onclick={() =>
					fork(
						confirm_action({
							title: t('Disconnect {name}?').replace(
								'{name}',
								choice === undefined ? '' : say(choice.label)
							),
							body: t('This logs the account out and deletes its stored credentials.'),
							confirm_label: t('Disconnect'),
							cancel_label: t('Cancel'),
							destructive: true
						}).pipe(Effect.flatMap((confirmed) => (confirmed ? unpair() : Effect.void)))
					)}>{t('Disconnect')}</Button
			>
		</Cluster>
	{/if}
</div>
