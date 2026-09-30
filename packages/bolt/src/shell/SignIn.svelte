<!--
	Sign-in (§5.11.2, rule 38a): a six-digit code, emailed or texted (a page runs the same two steps on-page through `bolt.session`). The card's content
	as staging's Bolt sign-in card had it: which workspace, then the address step, then the code step. Where the workspace
	lets newcomers sign up, the same two steps join them.
-->
<script lang="ts">
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Button, Input, Label, PinInput, Spinner } from '@norbital-ai/ui';
	import PhoneField from './PhoneField.svelte';
	import { based } from './nav.ts';
	import type { ShellApi } from './runtime.ts';

	/** Named under "Signing in to": the workspace's display name; `handle`, the tenant handle, only when it has none. */
	let { api, t, next, address: given = '', workspace, handle }: {
		api: ShellApi; t: (key: string) => string; next: string; address?: string; workspace?: string | undefined; handle?: string | undefined;
	} = $props();

	const methods = $derived(api.methods());
	// svelte-ignore state_referenced_locally
	let mode = $state<'email' | 'phone' | null>(given === '' ? null : given.includes('@') ? 'email' : 'phone');
	// svelte-ignore state_referenced_locally
	let email = $state(given.includes('@') ? given : '');
	// svelte-ignore state_referenced_locally
	let phone = $state<string | null>(given !== '' && !given.includes('@') ? given : null);
	let code = $state('');
	let form = $state<HTMLFormElement>();
	let sent = $state(false);
	/** A mobile number's code: texted (the default) or sent over WhatsApp, the member's choice. */
	let via = $state<'sms' | 'whatsapp'>('sms');
	let busy = $state(false);
	let error = $state<string | null>(null);
	const address = $derived(mode === 'phone' ? phone ?? '' : email);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		error = null;
		const r = sent ? await api.verify(address, code) : await api.sendCode(address, via);
		busy = false;
		if (!r.ok) return void (error = r.error.message);
		if (sent) location.assign(based(next));
		else sent = true;
	}
</script>

<Stack gap="sm">
	{#if handle || workspace}
		<Stack as="header" gap="xs" class="min-w-0">
			<p class="text-overline">{t('Signing in to')}</p>
			<p class="text-subhead break-words text-foreground">{workspace || handle}</p>
		</Stack>
	{/if}
	{#await methods}
		<Spinner class="h-4 w-4" />
	{:then m}
		<!-- a host that names no method (an old host) still signs in by email -->
		{@const byEmail = !m.ok || m.value.email}
		{@const byPhone = m.ok && m.value.phone}
		<!-- a workspace people sign up to by number opens on the number -->
		{@const current = mode ?? (byPhone && m.value.signup.includes('phone') ? 'phone' : byEmail ? 'email' : 'phone')}
		{@const joins = m.ok && m.value.signup.includes(current)}
		<Stack as="section" gap="lg">
			<Stack as="header" gap="sm">
				<h1 class="text-title text-balance">{sent ? t('Enter your code') : joins ? t('Sign in or sign up') : t('Sign in')}</h1>
				{#if sent}
					<p class="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{t('Sent to {email}').replace('{email}', address)}</p>
				{/if}
			</Stack>
			<form onsubmit={submit} bind:this={form}>
				<Stack gap="md">
					{#if sent}
						<Stack gap="sm">
							<Label for="bolt-code" class="text-foreground">{t('Six-digit code')}</Label>
							<!-- the sixth digit submits, as staging's did -->
							<PinInput id="bolt-code" bind:value={code} aria-invalid={error !== null} onComplete={() => form?.requestSubmit()} />
						</Stack>
					{:else if current === 'phone'}
						<Stack gap="sm">
							<Label for="bolt-phone" class="text-foreground">{t('Mobile number')}</Label>
							<PhoneField id="bolt-phone" locale={m.ok ? m.value.locale : navigator.language} value={phone} onChange={(v) => { mode = 'phone'; phone = v; }} />
						</Stack>
					{:else}
						<Stack gap="sm">
							<Label for="bolt-email" class="text-foreground">{t('Email address')}</Label>
							<Input id="bolt-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" bind:value={email}
								oninput={() => (mode = 'email')} />
						</Stack>
					{/if}
					{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
					<Button type="submit" class="w-full" disabled={busy || (sent ? code.length !== 6 : current === 'phone' ? phone === null : email === '')}
						onclick={() => (via = 'sms')}>
						<Inline as="span" gap="sm" justify="center">
							{#if busy && (sent || current !== 'phone' || via === 'sms')}<Spinner class="h-4 w-4" />{/if}
							{sent ? t('Verify and continue') : current === 'phone' ? t('Text me') : t('Send sign-in code')}
						</Inline>
					</Button>
					{#if !sent && current === 'phone' && m.ok && m.value.whatsapp}
						<Button type="submit" variant="outline" class="w-full" disabled={busy || phone === null} onclick={() => (via = 'whatsapp')}>
							<Inline as="span" gap="sm" justify="center">
								{#if busy && via === 'whatsapp'}<Spinner class="h-4 w-4" />{/if}
								{t('WhatsApp me')}
							</Inline>
						</Button>
					{/if}
					{#if !sent && byEmail && byPhone}
						<button type="button" class="text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground"
							onclick={() => { mode = current === 'phone' ? 'email' : 'phone'; error = null; }}>
							{current === 'phone' ? t('Use email instead') : t('Use a mobile number instead')}
						</button>
					{/if}
				</Stack>
			</form>
			<p class="border-t border-border pt-6 text-sm text-muted-foreground">
				{#if sent}
					{t('The code expires in ten minutes.')}
					<button type="button" class="underline underline-offset-4 hover:text-foreground" onclick={() => { sent = false; code = ''; error = null; }}>
						{current === 'phone' ? t('Change number') : t('Change email')}
					</button>
				{:else if current === 'phone'}
					{joins ? t("We'll send a six-digit code by text or WhatsApp. New here? The same code creates your account.") : t("We'll send a six-digit code by text or WhatsApp. No password required.")}
				{:else}
					{joins ? t("We'll email you a six-digit code. New here? The same code creates your account.") : t("We'll email you a six-digit code. No password required.")}
				{/if}
			</p>
		</Stack>
	{/await}
</Stack>
