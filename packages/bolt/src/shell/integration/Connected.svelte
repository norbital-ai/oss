<!--
	A connected instance's summary: who it answers as, through which provider, and the facts the host published (the
	webhook URL, an address, a bot); then its verbs. Test connection sends a short message where a conversation provider
	can (to a handle the operator types when the provider names one, else to the account itself) and runs the
	definition's own test; Reconnect draws the setup again; Disconnect unpairs.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, Input } from '@norbital-ai/ui';
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import { DRIVERS } from '../../decl/runtime/integration.ts';
	import Facts from './Facts.svelte';
	import { aboutOf, providerOf, sayOf, type IntegrationSetupProps } from './setup.ts';

	let {
		status,
		busy,
		error,
		unpair,
		test,
		reconnect,
		t,
		locale
	}: Pick<
		IntegrationSetupProps,
		'status' | 'busy' | 'error' | 'unpair' | 'test' | 't' | 'locale'
	> & {
		reconnect: () => void;
	} = $props();
	const say = $derived(sayOf(t, locale));
	const c = $derived(status);
	const active = $derived(providerOf(c));
	const facts = $derived<(readonly [string, Json])[]>([
		...(c?.account ? [[t('Connected as'), c.account] as const] : []),
		...(active === undefined ? [] : [[t('Provider'), say(active.label)] as const]),
		...Object.entries(aboutOf(c))
	]);
	// a conversation provider tests only when it says it can; any other driver runs its definition's own test
	const testable = $derived(
		c !== null && (c.test !== undefined || !('conversation' in DRIVERS[c.driver]))
	);
	// a provider with nothing to pair (setup `none`) has nothing to reconnect or disconnect
	const paired = $derived(active?.setup.kind !== 'none');
	let to = $state('');
	let tested = $state(false);
	function send(event: SubmitEvent): void {
		event.preventDefault();
		tested = false;
		fork(
			test(c?.test?.to === undefined ? undefined : to.trim()).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						tested = true;
					})
				)
			)
		);
	}
</script>

<Stack gap="md" data-setup-view="connected">
	<Facts {facts} {t} />
	<form class="flex flex-col gap-2" onsubmit={send} data-setup-test>
		{#if c?.test?.to !== undefined}
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-label">{say(c.test.to.label)}</span>
				<Input bind:value={to} required />
				{#if c.test.to.hint !== undefined}<span class="text-meta">{say(c.test.to.hint)}</span>{/if}
			</label>
		{/if}
		<Cluster gap="sm">
			{#if testable}<Button size="sm" variant="outline" type="submit" disabled={busy}
					>{t('Test connection')}</Button
				>{/if}
			{#if paired}
				<Button size="sm" variant="ghost" disabled={busy} onclick={reconnect}
					>{t('Reconnect')}</Button
				>
				<Button
					size="sm"
					variant="ghost"
					class="text-destructive"
					disabled={busy}
					onclick={() => fork(unpair())}>{t('Disconnect')}</Button
				>
			{/if}
			<!-- the holder shows a refused test as its error, so "passed" is only a test that drew none -->
			{#if tested && !busy && error === null}<span class="text-meta" aria-live="polite"
					>{t('Test passed')}</span
				>{/if}
		</Cluster>
	</form>
</Stack>
