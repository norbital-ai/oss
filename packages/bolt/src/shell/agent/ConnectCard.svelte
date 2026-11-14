<!--
	A held `connect` call: the connection's own setup, as Settings → Connections draws it, for the step only the person can
	do (a credential, a sign-in, a pairing code). Once the host reports it connected the turn resumes, and the agent reads
	the connection's state from the server; what is typed here goes to the host, never to the agent.
-->
<script lang="ts">
	import { Option, Schema } from 'effect';
	import { Button } from '@norbital-ai/ui';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { ShellApi } from '../api-types.ts';
	import IntegrationSetup from '../../page/IntegrationSetup.svelte';
	import { driverLabel } from '../integration/setup.ts';

	let {
		api,
		input,
		busy,
		problem,
		answer,
		t
	}: {
		api: Pick<ShellApi, 'integration'>;
		/** The held call's `{ instance, integration }`. */
		input: Json;
		busy: boolean;
		problem: string | null;
		/** Settles the card: `true` once connected, `false` to decline. */
		answer: (done: boolean) => void;
		t: (key: string) => string;
	} = $props();
	const held = $derived(
		Option.getOrUndefined(
			Schema.decodeUnknownOption(Schema.Struct({ instance: Schema.String, integration: Schema.String }))(input)
		)
	);
	const client = $derived(held === undefined ? undefined : api.integration(held.instance));
</script>

<p class="text-sm font-medium text-foreground">
	{t('Connect {integration}').replace('{integration}', driverLabel(held?.integration ?? ''))}
</p>
{#if client !== undefined}
	<div class="mt-2" data-connect-setup>
		<IntegrationSetup
			{client}
			{t}
			on_state_change={(state) => {
				if (state === 'connected' && !busy) answer(true);
			}}
		/>
	</div>
{/if}
<Inline gap="xs" class="mt-2" align="center">
	<Button variant="outline" disabled={busy} onclick={() => answer(false)}>{t('Decline')}</Button>
	{#if busy}<span class="text-xs text-muted-foreground" role="status">{t('Working on it… you can keep using the app.')}</span>{/if}
</Inline>
{#if problem !== null}<p class="mt-2 text-sm text-destructive" role="alert">{problem}</p>{/if}
