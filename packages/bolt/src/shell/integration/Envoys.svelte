<!--
	Each envoy's channel, as connectors: an envoy answers on one workspace instance (owner none, its `envoy` set; the data
	refuses a second). Without one, every conversation definition this host can connect is offered, and Connect makes
	the instance for the envoy and pairs it in one click (WhatsApp shows its QR, a mailbox signs in with Google, Telegram
	asks for its bot token). Disconnect unpairs it and deletes it — a `+workspace.ts` connection is source's, so it is
	only unpaired.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { query } from '@norbital-ai/ui/effect';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from '../settings/data.ts';
	import Connector from './Connector.svelte';
	import { instanceMade } from './setup.ts';

	let {
		api,
		bolt,
		settings,
		t,
		locale
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		settings: Settings;
		t: (key: string) => string;
		locale: string;
	} = $props();

	const offers = query(() =>
		api
			.integrationOffers()
			.pipe(Effect.map((all) => all.filter((o) => o.conversation && o.workspace.length > 0)))
	);
	const channelOf = (envoy: string) => settings.instances.find((i) => i.envoy === envoy);
	const created = (envoy: Settings['envoys'][number], integration: string) =>
		bolt
			.act('sys_integration.create', { integration, name: envoy.name, envoy: envoy.id })
			.pipe(
				Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.')))
			);
	const removed = (instance: string) =>
		settings.instances.find((i) => i.id === instance)?.named === true
			? Effect.void
			: bolt.act('sys_integration.delete', { target: instance }).pipe(Effect.asVoid);
</script>

<Stack gap="md" data-envoys>
	<header class="flex flex-col gap-1">
		<h2 class="text-sm font-medium">{t('Envoys')}</h2>
		<p class="text-meta">{t('Each envoy answers on one channel. Connect it with one click.')}</p>
	</header>
	{#if offers.error !== undefined}<p role="alert" class="text-sm text-destructive">
			{offers.error.message}
		</p>{/if}
	{#each settings.envoys as e (e.id)}
		{@const channel = channelOf(e.id)}
		<section class="flex flex-col gap-2" data-envoy={e.id}>
			<p class="text-sm">
				{e.name}
				<span class="text-meta">· {t(e.audience === 'public' ? 'Public' : 'Private')}</span>
			</p>
			<!-- keyed by definition: the connector a click made keeps its open setup once the channel exists -->
			<ul class="flex flex-col gap-2">
				{#each (offers.current ?? []).filter((o) => channel === undefined || o.integration === channel.integration) as o (o.integration)}
					<Connector
						driver={o.driver}
						description={o.description}
						providers={o.workspace}
						instance={channel === undefined ? null : { id: channel.id, status: channel.status }}
						client={(instance) => api.integration(instance)}
						create={() => created(e, o.integration)}
						remove={removed}
						{t}
						{locale}
					/>
				{/each}
			</ul>
		</section>
	{/each}
</Stack>
