<script lang="ts">
	import { Effect } from 'effect';
	import { Button } from '@norbital-ai/ui/button';
	import { Input } from '@norbital-ai/ui/input';
	import { Label } from '@norbital-ai/ui/label';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { PinInput } from '@norbital-ai/ui/pin-input';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import {
		identityCopy,
		identityFailureMessage,
		type IdentityLocale,
		type SignInTransport
	} from '#lib/client/ui/identity/i18n.js';

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

	const send = (): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (submitting) return Effect.void;
			submitting = true;
			errorMessage = undefined;
			return Effect.map(
				Effect.tryPromise(() => transport.sendCode(email.trim().toLowerCase())),
				(result) => {
					if (!result.ok) {
						errorMessage = identityFailureMessage(locale, result.reason);
						return;
					}
					code = '';
					step = 'code';
				}
			);
		}).pipe(
			Effect.catch(() => {
				errorMessage = copy['bolt.identity.genericError'];
				return Effect.void;
			}),
			Effect.ensuring(Effect.sync(() => (submitting = false)))
		);

	const verify = (): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (submitting || code.length !== 6) return Effect.void;
			submitting = true;
			errorMessage = undefined;
			return Effect.map(
				Effect.tryPromise(() => transport.verifyCode(email.trim().toLowerCase(), code)),
				(result) => {
					if (!result.ok) {
						errorMessage = identityFailureMessage(locale, result.reason);
						return;
					}
					onAuthenticated();
				}
			);
		}).pipe(
			Effect.catch(() => {
				errorMessage = copy['bolt.identity.genericError'];
				return Effect.void;
			}),
			Effect.ensuring(Effect.sync(() => (submitting = false)))
		);

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
				void Effect.runPromise(send());
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
					<Inline as="span" gap="sm" justify="center">
						{#if submitting}
							<Spinner class="h-4 w-4" />
						{/if}
						{copy['bolt.identity.sendCode']}
					</Inline>
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
				void Effect.runPromise(verify());
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
				<Button type="submit" class="w-full" disabled={submitting || code.length !== 6}>
					<Inline as="span" gap="sm" justify="center">
						{#if submitting}
							<Spinner class="h-4 w-4" />
						{/if}
						{copy['bolt.identity.verifyAndContinue']}
					</Inline>
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
