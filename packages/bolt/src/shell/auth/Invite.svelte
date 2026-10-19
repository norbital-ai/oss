<!--
	Invitation accept (§5.11, rule 38b): inspecting the link consumes nothing. A new address signs in with a code, which
	creates the member and accepts in one act; a signed-in member of the invited address accepts here.
-->
<script lang="ts">
	import { query, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { Stack } from '@norbital-ai/ui/layout';
	import { Button, Spinner } from '@norbital-ai/ui';
	import { based } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';
	import SignIn from './SignIn.svelte';

	let {
		api,
		t,
		id,
		signedIn,
		workspace
	}: {
		api: ShellApi;
		t: (key: string) => string;
		id: string;
		signedIn: boolean;
		workspace?: string | undefined;
	} = $props();

	const view = query(() => api.invitation(id));
	let busy = $state(false);
	let error = $state<string | null>(null);

	const accept = Effect.fn('Invite.accept')(function* () {
		if (busy) return;
		busy = true;
		error = null;
		const r = yield* Effect.result(api.accept(id));
		busy = false;
		if (r._tag === 'Success') location.assign(based('/'));
		else error = r.failure.message;
	});
</script>

{#if view.current?.status === 'open' && !signedIn}
	<SignIn {api} {t} next="/" address={view.current.email ?? view.current.phone ?? ''} {workspace} />
{:else}
	<Stack gap="sm" grow class="access-invitation" aria-busy={view.loading || busy}>
		{#if workspace}
			<Stack as="header" gap="xs" class="access-identity min-w-0">
				<p class="text-overline">{t('Signing in to')}</p>
				<p class="text-subhead break-words text-foreground">{workspace}</p>
			</Stack>
		{/if}
		<Stack gap="lg" grow class="access-invitation-content">
			<h1 class="text-title text-balance">{t('Accept the invitation')}</h1>
			<p
				class="access-invitation-description text-sm leading-relaxed text-muted-foreground"
				role={view.error || (view.current && view.current.status !== 'open') ? 'alert' : 'status'}
			>
				{#if view.loading}
					{t('Loading…')}
				{:else if view.error}
					{view.error.message}
				{:else if view.current?.status !== 'open'}
					{view.current ? t(`This invitation is ${view.current.status}.`) : ''}
				{:else}
					{t('You are invited to this workspace as')}
					{view.current.email ?? view.current.phone}.
				{/if}
			</p>
			<p role="alert" class="access-invitation-error text-sm text-destructive">{error ?? ''}</p>
			{#if view.loading || view.current?.status === 'open'}
				<Button
					class="access-invitation-action w-full"
					disabled={view.loading || busy}
					onclick={() => fork(accept())}
				>
					<span class="access-invitation-progress" aria-hidden="true">
						{#if view.loading || busy}<Spinner class="h-4 w-4" />{/if}
					</span>
					{t('Accept the invitation')}
				</Button>
			{/if}
		</Stack>
	</Stack>
{/if}

<style>
	.access-invitation-description,
	.access-invitation-error {
		min-block-size: 3em;
		overflow-wrap: anywhere;
	}
	:global(.access-invitation-action) {
		position: relative;
	}
	.access-invitation-progress {
		position: absolute;
		inset-inline-start: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
	}
</style>
