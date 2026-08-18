<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Input } from '@norbital-ai/ui/input';
	import { Label } from '@norbital-ai/ui/label';
	import { Stack } from '@norbital-ai/ui/layout';
	import { PinInput } from '@norbital-ai/ui/pin-input';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import {
		identityCopy,
		identityFailureMessage,
		type IdentityLocale,
		type SignInTransport
	} from './i18n.js';

	let {
		locale = 'en',
		transport,
		onAuthenticated
	}: {
		locale?: IdentityLocale;
		transport: SignInTransport;
		onAuthenticated: () => void;
	} = $props();

	const copy = $derived(identityCopy(locale));
	let step = $state<'email' | 'code'>('email');
	let email = $state('');
	let code = $state('');
	let submitting = $state(false);
	let errorMessage = $state<string | undefined>(undefined);

	const send = async (): Promise<void> => {
		if (submitting) return;
		submitting = true;
		errorMessage = undefined;
		const result = await transport.sendCode(email.trim().toLowerCase());
		submitting = false;
		if (!result.ok) {
			errorMessage = identityFailureMessage(locale, result.reason);
			return;
		}
		code = '';
		step = 'code';
	};

	const verify = async (): Promise<void> => {
		if (submitting || code.length !== 6) return;
		submitting = true;
		errorMessage = undefined;
		const result = await transport.verifyCode(email.trim().toLowerCase(), code);
		submitting = false;
		if (!result.ok) {
			errorMessage = identityFailureMessage(locale, result.reason);
			return;
		}
		onAuthenticated();
	};

	const changeEmail = (): void => {
		code = '';
		errorMessage = undefined;
		step = 'email';
	};
</script>

{#if step === 'email'}
	<Stack
		as="section"
		gap="lg"
		class="rounded-lg border border-border/80 bg-card/95 p-5 shadow-xs backdrop-blur-sm sm:p-7"
	>
		<Stack as="header" gap="sm">
			<h1 class="text-title text-balance">{copy['bolt.identity.headingSignIn']}</h1>
		</Stack>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<Stack gap="md">
				<Stack gap="sm">
					<Label for="bolt-email" class="text-foreground">{copy['bolt.identity.emailLabel']}</Label>
					<Input
						id="bolt-email"
						name="email"
						type="email"
						autocomplete="email"
						required
						placeholder={copy['bolt.identity.emailPlaceholder']}
						bind:value={email}
					/>
				</Stack>
				{#if errorMessage}
					<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
				{/if}
				<Button type="submit" class="w-full" disabled={submitting}>
					{#if submitting}
						<Spinner class="mr-2 h-4 w-4" />
					{/if}
					{copy['bolt.identity.sendCode']}
				</Button>
			</Stack>
		</form>
		<p class="border-t border-border pt-6 text-sm text-muted-foreground">
			{copy['bolt.identity.noPasswordHint']}
		</p>
	</Stack>
{:else}
	<Stack
		as="section"
		gap="lg"
		class="rounded-lg border border-border/80 bg-card/95 p-5 shadow-xs backdrop-blur-sm sm:p-7"
	>
		<Stack as="header" gap="sm">
			<h1 class="text-title text-balance">{copy['bolt.identity.headingEnterCode']}</h1>
			<p class="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
				{copy['bolt.identity.sentTo'].replace('{email}', email)}
			</p>
		</Stack>
		<form
			onsubmit={(event) => {
				event.preventDefault();
			}}
		>
			<Stack gap="md">
				<Stack gap="sm">
					<Label for="bolt-code" class="text-foreground">{copy['bolt.identity.codeLabel']}</Label>
					<PinInput id="bolt-code" bind:value={code} maxlength={6} />
				</Stack>
				{#if errorMessage}
					<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
				{/if}
				<Button
					type="button"
					class="w-full"
					disabled={submitting || code.length !== 6}
					onclick={() => void verify()}
				>
					{#if submitting}
						<Spinner class="mr-2 h-4 w-4" />
					{/if}
					{copy['bolt.identity.verifyAndContinue']}
				</Button>
			</Stack>
		</form>
		<p class="border-t border-border pt-6 text-sm text-muted-foreground">
			{copy['bolt.identity.codeExpiresPrefix']}
			<button
				type="button"
				class="underline underline-offset-4 hover:text-foreground"
				onclick={changeEmail}
			>
				{copy['bolt.identity.changeEmail']}
			</button>
		</p>
	</Stack>
{/if}
