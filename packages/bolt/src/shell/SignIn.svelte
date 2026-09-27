<!--
	Sign-in (§5.11.2, rule 38a): an emailed six-digit code; no authored page can build its own. The card's content as
	staging's Bolt sign-in card had it: which workspace, then the email step, then the code step.
-->
<script lang="ts">
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Button, Input, Label, PinInput, Spinner } from '@norbital-ai/ui';
	import type { ShellApi } from './runtime.ts';

	/** `handle`: the tenant handle, named under "Signing in to" as staging did; the workspace name when absent. */
	let { api, t, next, email = '', workspace, handle }: {
		api: ShellApi; t: (key: string) => string; next: string; email?: string; workspace?: string | undefined; handle?: string | undefined;
	} = $props();

	// svelte-ignore state_referenced_locally
	let address = $state(email);
	let code = $state('');
	let form = $state<HTMLFormElement>();
	let sent = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		busy = true;
		error = null;
		const r = sent ? await api.verify(address, code) : await api.sendCode(address);
		busy = false;
		if (!r.ok) return void (error = r.error.message);
		if (sent) location.assign(next);
		else sent = true;
	}
</script>

<Stack gap="sm">
	{#if handle || workspace}
		<Stack as="header" gap="xs" class="min-w-0">
			<p class="text-overline">{t('Signing in to')}</p>
			<p class="text-subhead break-words text-foreground">{handle || workspace}</p>
		</Stack>
	{/if}
	<Stack as="section" gap="lg">
		<Stack as="header" gap="sm">
			<h1 class="text-title text-balance">{sent ? t('Enter your code') : t('Sign in')}</h1>
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
				{:else}
					<Stack gap="sm">
						<Label for="bolt-email" class="text-foreground">{t('Email address')}</Label>
						<Input id="bolt-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" bind:value={address} />
					</Stack>
				{/if}
				{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
				<Button type="submit" class="w-full" disabled={busy || (sent && code.length !== 6)}>
					<Inline as="span" gap="sm" justify="center">
						{#if busy}<Spinner class="h-4 w-4" />{/if}
						{sent ? t('Verify and continue') : t('Send sign-in code')}
					</Inline>
				</Button>
			</Stack>
		</form>
		<p class="border-t border-border pt-6 text-sm text-muted-foreground">
			{#if sent}
				{t('The code expires in ten minutes.')}
				<button type="button" class="underline underline-offset-4 hover:text-foreground" onclick={() => { sent = false; code = ''; error = null; }}>
					{t('Change email')}
				</button>
			{:else}
				{t("We'll email you a six-digit code. No password required.")}
			{/if}
		</p>
	</Stack>
</Stack>
