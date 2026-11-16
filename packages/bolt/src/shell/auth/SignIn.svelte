<!--
	Sign-in: a six-digit code, emailed or texted (a page runs the same two steps on-page through `bolt.session`), on ui's
	`AccessCard`: which workspace, then the address step, then the code step. Where the workspace
	lets newcomers sign up, the same two steps join them.
-->
<script lang="ts">
	import { observe_once, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import { Button, Input, Label, PinInput, Spinner } from '@norbital-ai/ui';
	import { AccessCard } from '@norbital-ai/ui/brand';
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

	const methods = observe_once(() => api.methods());
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
		const verifying = sent,
			target = address,
			digits = code,
			channel = via;
		let navigating = false;
		fork(
			Effect.gen(function* () {
				const r = verifying
					? yield* Effect.result(api.verify(target, digits))
					: yield* Effect.result(api.send_code(target, channel));
				if (r._tag === 'Failure') return void (error = r.failure.message);
				if (verifying) {
					navigating = true;
					location.assign(based(next));
				} else sent = true;
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						busy = navigating;
					})
				)
			)
		);
	}
</script>

<AccessCard
	eyebrow={handle || workspace ? t('Signing in to') : undefined}
	name={workspace || handle}
	title={sent ? t('Enter your code') : joins ? t('Sign in or sign up') : t('Sign in')}
	description={sent ? t('Sent to {email}').replace('{email}', address) : undefined}
>
	<form onsubmit={submit} bind:this={form} aria-busy={methods.loading || busy}>
		<fieldset disabled={methods.loading || busy}>
			<Stack gap="sm">
				{#if sent}
					<Stack gap="xs">
						<Label for="bolt-code" class="text-foreground">{t('Six-digit code')}</Label>
						<!-- the sixth digit submits, on completion -->
						<PinInput
							id="bolt-code"
							bind:value={code}
							aria-invalid={error !== null}
							on_complete={() => form?.requestSubmit()}
						/>
					</Stack>
				{:else if current === 'phone'}
					<Stack gap="xs">
						<Label for="bolt-phone" class="text-foreground">{t('Mobile number')}</Label>
						{#key methods.current?.locale ?? navigator.language}
							<PhoneField
								id="bolt-phone"
								locale={methods.current?.locale ?? navigator.language}
								value={phone}
								on_change={(v) => {
									mode = 'phone';
									phone = v;
								}}
							/>
						{/key}
					</Stack>
				{:else}
					<Stack gap="xs">
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
				<p class="access-error text-sm text-destructive" role="alert">{error ?? ''}</p>
				<Grid
					tracks={!sent && current === 'phone' && methods.current?.whatsapp
						? 'repeat(2, minmax(0, 1fr))'
						: 'minmax(0, 1fr)'}
					gap="sm"
				>
					<Button
						type="submit"
						class="access-action w-full"
						disabled={methods.loading ||
							busy ||
							(sent ? code.length !== 6 : current === 'phone' ? phone === null : email === '')}
						onclick={() => (via = 'sms')}
					>
						<span class="access-progress" aria-hidden="true">
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
							class="access-action w-full"
							disabled={methods.loading || busy || phone === null}
							onclick={() => (via = 'whatsapp')}
						>
							<span class="access-progress" aria-hidden="true">
								{#if busy && via === 'whatsapp'}<Spinner class="h-4 w-4" />{/if}
							</span>
							<span>{t('WhatsApp me')}</span>
						</Button>
					{/if}
				</Grid>
				{#if !sent && byEmail && byPhone}
					<button
						type="button"
						disabled={busy}
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
		</fieldset>
	</form>
	{#snippet hint()}
		{#if sent}
			{t('The code expires in ten minutes.')}
			<button
				type="button"
				disabled={busy}
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
	{/snippet}
</AccessCard>
<span class="sr-only" role="status">{methods.loading ? t('Loading…') : ''}</span>

<style>
	fieldset {
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
