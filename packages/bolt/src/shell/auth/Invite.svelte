<!--
	Invitation accept: inspecting the link consumes nothing. A new address signs in with a code, which
	creates the member and accepts in one act; a signed-in member of the invited address accepts here.
-->
<script lang="ts">
	import { observe_once, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { AccessCard } from '@norbital-ai/ui/brand';
	import { Button, Spinner } from '@norbital-ai/ui';
	import { based } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';
	import SignIn from './SignIn.svelte';

	let {
		api,
		t,
		id,
		signed_in,
		workspace
	}: {
		api: ShellApi;
		t: (key: string) => string;
		id: string;
		signed_in: boolean;
		workspace?: string | undefined;
	} = $props();

	const view = observe_once(() => api.invitation(id));
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

{#if view.current?.status === 'open' && !signed_in}
	<SignIn {api} {t} next="/" address={view.current.email ?? view.current.phone ?? ''} {workspace} />
{:else}
	<AccessCard
		eyebrow={workspace ? t('Signing in to') : undefined}
		name={workspace}
		title={t('Accept the invitation')}
	>
		<p
			class="access-error text-sm leading-relaxed text-muted-foreground"
			role={view.error || (view.current && view.current.status !== 'open') ? 'alert' : 'status'}
			aria-busy={view.loading || busy}
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
		<p role="alert" class="access-error text-sm text-destructive">{error ?? ''}</p>
		{#if view.loading || view.current?.status === 'open'}
			<Button
				class="access-action w-full"
				disabled={view.loading || busy}
				onclick={() => fork(accept())}
			>
				<span class="access-progress" aria-hidden="true">
					{#if view.loading || busy}<Spinner class="h-4 w-4" />{/if}
				</span>
				{t('Accept the invitation')}
			</Button>
		{/if}
	</AccessCard>
{/if}
