<!--
	Envoy registration (§3.9, rule 57): opening the link only inspects the claim and shows the handle it names; the
	signed-in member links it with one press. Messages sent before registering are answered only when ticked.
-->
<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';
	import { Button } from '@norbital-ai/ui';
	import type { ShellApi } from './runtime.ts';

	let { api, t, claim }: { api: ShellApi; t: (key: string) => string; claim: string } = $props();

	const view = $derived(api.registration(claim));
	let replay = $state(false);
	let done = $state<string | null>(null);
	let busy = $state(false);
	const SAID: { readonly [state: string]: string } = {
		registered: 'Your account is linked. You can reply in the chat.', already_registered: 'This account is already linked to you.',
		expired: 'This link has expired. Send another message to get a new one.', used: 'This link was used by another member.',
		conflict: 'Another member already uses this account.', invalid: 'This link is not valid.',
	};

	async function link(): Promise<void> {
		busy = true;
		const r = await api.register(claim, replay);
		busy = false;
		done = r.ok ? t(SAID[r.value.state] ?? SAID['invalid']!) : r.error.message;
	}
</script>

{#await view}
	<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
{:then r}
	{#if done !== null}
		<p role="status" class="text-sm">{done}</p>
	{:else if !r.ok}
		<p role="alert" class="text-sm">{r.error.message}</p>
	{:else if r.value.state !== 'ready'}
		<p role="alert" class="text-sm">{t(r.value.state === 'registered' ? 'This link was already used.' : SAID[r.value.state] ?? SAID['invalid']!)}</p>
	{:else}
		<Stack gap="lg">
			<h1 class="text-title text-balance">{t('Link my account')}</h1>
			<p class="text-sm leading-relaxed text-muted-foreground">{t('Link this account to you:')} <strong class="text-foreground">{r.value.handle}</strong> ({r.value.transport})</p>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={replay} />
				{t('Also answer the messages I sent before registering')}
			</label>
			<Button class="w-full" onclick={link} disabled={busy}>{t('Link my account')}</Button>
		</Stack>
	{/if}
{/await}
