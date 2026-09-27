<!--
	Invitation accept (§5.11, rule 38b): inspecting the link consumes nothing. A new address signs in with a code, which
	creates the member and accepts in one act; a signed-in member of the invited address accepts here.
-->
<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';
	import { Button } from '@norbital-ai/ui';
	import { based } from './nav.ts';
	import type { ShellApi } from './runtime.ts';
	import SignIn from './SignIn.svelte';

	let { api, t, id, signedIn, workspace }: { api: ShellApi; t: (key: string) => string; id: string; signedIn: boolean; workspace?: string | undefined } = $props();

	const view = $derived(api.invitation(id));
	let error = $state<string | null>(null);

	async function accept(): Promise<void> {
		const r = await api.accept(id);
		if (r.ok) location.assign(based('/'));
		else error = r.error.message;
	}
</script>

{#await view}
	<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
{:then r}
	{#if !r.ok || r.value.status !== 'open'}
		<p role="alert" class="text-sm">{r.ok ? t(`This invitation is ${r.value.status}.`) : r.error.message}</p>
	{:else if signedIn}
		<Stack gap="lg">
			<h1 class="text-title text-balance">{t('Accept the invitation')}</h1>
			<p class="text-sm leading-relaxed text-muted-foreground">{t('You are invited to this workspace as')} {r.value.email}.</p>
			{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<Button class="w-full" onclick={accept}>{t('Accept the invitation')}</Button>
		</Stack>
	{:else}
		<SignIn {api} {t} next="/" email={r.value.email} {workspace} />
	{/if}
{/await}
