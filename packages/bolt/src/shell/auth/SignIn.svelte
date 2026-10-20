<!--
	Sign-in (§5.11.2, rule 38a): a six-digit code, emailed or texted (a page runs the same two steps on-page through `bolt.session`). The card's content
	 which workspace, then the address step, then the code step. Where the workspace
	lets newcomers sign up, the same two steps join them.
-->
<script lang="ts">
	import { query, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import { Button, Input, Label, PinInput, Spinner } from '@norbital-ai/ui';
	import PhoneField from './PhoneField.svelte';
	import { based } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';

	/** Named under "Signing in to": the workspace's display name; `handle`, the tenant handle, only when it has none. */
	let {
		api,
		t,
		next,
		address: given = '',
		workspace,
		handle
	}: {
		api: ShellApi;
		t: (key: string) => string;
		next: string;
		address?: string;
		workspace?: string | undefined;
		handle?: string | undefined;
	} = $props();

	const methods = query(() => api.methods());
	// An old host, or a failed methods read, still signs in by email.
	const byEmail = $derived(methods.current?.email ?? true);
	const byPhone = $derived(methods.current?.phone ?? false);
	// svelte-ignore state_referenced_locally
	let mode = $state<'email' | 'phone' | null>(
		given === '' ? null : given.includes('@') ? 'email' : 'phone'
	);
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
	const current = $derived(mode ?? (byEmail ? 'email' : 'phone'));
	const joins = $derived(methods.current?.signup.includes(current) ?? false);
	const address = $derived(current === 'phone' ? (phone ?? '') : email);

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		if (methods.loading || busy) return;
		busy = true;
		error = null;
		fork(
			Effect.gen(function* () {
				const r = sent
					? yield* Effect.result(api.verify(address, code))
					: yield* Effect.result(api.sendCode(address, via));
				if (r._tag === 'Failure') return void (error = r.failure.message);
				if (sent) location.assign(based(next));
				else sent = true;
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
		);
	}
</script>

<Stack gap="sm" class="access-sign-in" aria-busy={methods.loading || busy}>
	{#if handle || workspace}
		<Stack as="header" gap="xs" class="access-identity min-w-0">
			<p class="text-overline">{t('Signing in to')}</p>
			<p class="text-subhead break-words text-foreground">{workspace || handle}</p>
		</Stack>
	{/if}
	<Stack as="section" gap="md" class="access-sign-in-content">
		<Stack as="header" gap="xs">
			<h1 class="text-section text-balance">
				{sent ? t('Enter your code') : joins ? t('Sign in or sign up') : t('Sign in')}
			</h1>
			{#if sent}
				<p
					class="access-sign-in-description max-w-[52ch] text-sm leading-relaxed text-muted-foreground"
				>
					{t('Sent to {email}').replace('{email}', address)}
				</p>
			{/if}
		</Stack>
		<form onsubmit={submit} bind:this={form}>
			<fieldset disabled={methods.loading || busy}>
				<Stack gap="sm">
					{#if sent}
						<Stack gap="xs" class="access-sign-in-field">
							<Label for="bolt-code" class="text-foreground">{t('Six-digit code')}</Label>
							<!-- the sixth digit submits, on completion -->
							<PinInput
								id="bolt-code"
								bind:value={code}
								aria-invalid={error !== null}
								onComplete={() => form?.requestSubmit()}
							/>
						</Stack>
					{:else if current === 'phone'}
						<Stack gap="xs" class="access-sign-in-field">
							<Label for="bolt-phone" class="text-foreground">{t('Mobile number')}</Label>
							{#key methods.current?.locale ?? navigator.language}
								<PhoneField
									id="bolt-phone"
									locale={methods.current?.locale ?? navigator.language}
									value={phone}
									onChange={(v) => {
										mode = 'phone';
										phone = v;
									}}
								/>
							{/key}
						</Stack>
					{:else}
						<Stack gap="xs" class="access-sign-in-field">
							<Label for="bolt-email" class="text-foreground">{t('Email address')}</Label>
							<Input
								id="bolt-email"
								name="email"
								type="email"
								autocomplete="email"
								required
								placeholder="you@company.com"
								bind:value={email}
								oninput={() => (mode = 'email')}
							/>
						</Stack>
					{/if}
					<p class="access-sign-in-error text-sm text-destructive" role="alert">{error ?? ''}</p>
					<Stack gap="sm" class="access-sign-in-actions">
						<Grid
							tracks={!sent && current === 'phone' && methods.current?.whatsapp
								? 'repeat(2, minmax(0, 1fr))'
								: 'minmax(0, 1fr)'}
							gap="sm"
						>
							<Button
								type="submit"
								class="access-sign-in-action w-full"
								disabled={methods.loading ||
									busy ||
									(sent ? code.length !== 6 : current === 'phone' ? phone === null : email === '')}
								onclick={() => (via = 'sms')}
							>
								<span class="access-sign-in-progress" aria-hidden="true">
									{#if methods.loading || (busy && (sent || current !== 'phone' || via === 'sms'))}
										<Spinner class="h-4 w-4" />
									{/if}
								</span>
								<span>
									{sent
										? t('Verify and continue')
										: current === 'phone'
											? t('Text me')
											: t('Send sign-in code')}
								</span>
							</Button>
							{#if !sent && current === 'phone' && methods.current?.whatsapp}
								<Button
									type="submit"
									variant="outline"
									class="access-sign-in-action w-full"
									disabled={methods.loading || busy || phone === null}
									onclick={() => (via = 'whatsapp')}
								>
									<span class="access-sign-in-progress" aria-hidden="true">
										{#if busy && via === 'whatsapp'}<Spinner class="h-4 w-4" />{/if}
									</span>
									<span>{t('WhatsApp me')}</span>
								</Button>
							{/if}
						</Grid>
						{#if !sent && byEmail && byPhone}
							<button
								type="button"
								class="text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground"
								onclick={() => {
									mode = current === 'phone' ? 'email' : 'phone';
									error = null;
								}}
							>
								{current === 'phone' ? t('Use email instead') : t('Use a mobile number instead')}
							</button>
						{/if}
					</Stack>
				</Stack>
			</fieldset>
		</form>
		<p class="access-sign-in-footer border-t border-border pt-4 text-sm text-muted-foreground">
			{#if sent}
				{t('The code expires in ten minutes.')}
				<button
					type="button"
					class="underline underline-offset-4 hover:text-foreground"
					onclick={() => {
						sent = false;
						code = '';
						error = null;
					}}
				>
					{current === 'phone' ? t('Change number') : t('Change email')}
				</button>
			{:else if current === 'phone'}
				{joins
					? t(
							"We'll send a six-digit code by text or WhatsApp. New here? The same code creates your account."
						)
					: t("We'll send a six-digit code by text or WhatsApp. No password required.")}
			{:else}
				{joins
					? t("We'll email you a six-digit code. New here? The same code creates your account.")
					: t("We'll email you a six-digit code. No password required.")}
			{/if}
		</p>
	</Stack>
	<span class="sr-only" role="status">{methods.loading ? t('Loading…') : ''}</span>
</Stack>

<style>
	fieldset {
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	:global(.access-sign-in-description),
	:global(.access-sign-in-error) {
		min-block-size: 1.5em;
		overflow-wrap: anywhere;
	}
	:global(.access-sign-in-field input),
	:global(.access-sign-in-field button),
	:global(.access-sign-in-action) {
		min-block-size: 2.75rem;
	}
	:global(.access-sign-in-action) {
		position: relative;
	}
	.access-sign-in-progress {
		position: absolute;
		inset-inline-start: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
	}
	:global(.access-sign-in-footer) {
		min-block-size: 3em;
	}
	@media (orientation: landscape) and (max-height: 500px) and (min-width: 640px) and (pointer: coarse) {
		:global(.access-sign-in-content) {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 0.75rem 1.5rem;
			align-items: start;
		}
		:global(.access-sign-in-content > header) {
			grid-column: 1;
		}
		:global(.access-sign-in-content > header h1) {
			font-size: 1.5rem;
			line-height: 1.2;
		}
		:global(.access-sign-in-content > form) {
			grid-column: 2;
			grid-row: 1 / span 2;
		}
		:global(.access-sign-in-content > p) {
			grid-column: 1;
			grid-row: 2;
			padding-top: 0.5rem;
		}
	}
</style>
