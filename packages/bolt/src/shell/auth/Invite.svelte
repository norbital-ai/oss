<!--
	Invitation accept (§5.11, rule 38b): inspecting the link consumes nothing. A new address signs in with a code, which
	creates the member and accepts in one act; a signed-in member of the invited address accepts here.
-->
<script lang="ts">
	import { run, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { Stack } from '@norbital-ai/ui/layout';
	import { Button } from '@norbital-ai/ui';
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

	const view = $derived(run(Effect.result(api.invitation(id))));
	let error = $state<string | null>(null);

	const accept = Effect.fn('Invite.accept')(function* () {
		const r = yield* Effect.result(api.accept(id));
		if (r._tag === 'Success') location.assign(based('/'));
		else error = r.failure.message;
	});
</script>

{#await view}
	<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
{:then r}
	{#if r._tag === 'Failure' || r.success.status !== 'open'}
		<p role="alert" class="text-sm">
			{r._tag === 'Success' ? t(`This invitation is ${r.success.status}.`) : r.failure.message}
		</p>
	{:else if signedIn}
		<Stack gap="lg">
			<h1 class="text-title text-balance">{t('Accept the invitation')}</h1>
			<p class="text-sm leading-relaxed text-muted-foreground">
				{t('You are invited to this workspace as')}
				{r.success.email ?? r.success.phone}.
			</p>
			{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<Button class="w-full" onclick={() => fork(accept())}>{t('Accept the invitation')}</Button>
		</Stack>
	{:else}
		<SignIn {api} {t} next="/" address={r.success.email ?? r.success.phone ?? ''} {workspace} />
	{/if}
{/await}
