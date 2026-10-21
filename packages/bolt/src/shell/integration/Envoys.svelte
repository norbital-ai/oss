<!--
	Each envoy's channels, as connectors: every workspace instance with its `envoy` set appears once. Without one,
	every conversation definition this host can connect is offered, and Connect makes
	the instance for the envoy and pairs it in one click (WhatsApp shows its QR, a mailbox signs in with Google, Telegram
	asks for its bot token). Disconnect unpairs it and deletes it — a `+workspace.ts` connection is source's, so it is
	only unpaired — then the settings are read again.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { query } from '@norbital-ai/ui/effect';
	import { Button } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { IntegrationOffer } from '../../protocol/instance-status.ts';
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
		locale,
		onManage,
		reload
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		settings: Settings;
		t: (key: string) => string;
		locale: string;
		onManage: (instance: string) => void;
		/** Re-reads the settings after a channel was removed. */
		reload: () => Effect.Effect<void>;
	} = $props();

	const offers = query(() =>
		api.integrationOffers().pipe(Effect.map((all) => all.filter((o) => o.conversation)))
	);
	const channelsOf = (envoy: string) => settings.instances.filter((i) => i.envoy === envoy);
	const created = (envoy: Settings['envoys'][number], integration: string) =>
		bolt
			.act('sys_integration.create', { integration, name: envoy.name, envoy: envoy.id })
			.pipe(
				Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.')))
			);
	const removed = (instance: string) =>
		(settings.instances.find((i) => i.id === instance)?.named === true
			? Effect.succeed(false)
			: bolt
					.act('sys_integration.delete', { target: instance })
					.pipe(Effect.map((outcome) => outcome.kind === 'committed'))
		).pipe(Effect.tap(() => reload()));
</script>

{#snippet connector(
	e: Settings['envoys'][number],
	o: IntegrationOffer,
	channel: Settings['instances'][number] | undefined
)}
	<Connector
		driver={o.driver}
		description={o.description}
		providers={o.workspace}
		instance={channel === undefined
			? null
			: { id: channel.id, status: channel.status, active: channel.active }}
		client={(instance) => api.integration(instance)}
		create={() => created(e, o.integration)}
		remove={removed}
		{onManage}
		{t}
		{locale}
	/>
{/snippet}

<Stack gap="md" data-envoys>
	<header class="flex flex-col gap-1">
		<h2 class="text-sm font-medium">{t('Agent channels')}</h2>
		<p class="text-meta">{t('Connect an account for each agent to answer messages.')}</p>
	</header>
	{#if offers.error !== undefined}<p role="alert" class="text-sm text-destructive">
			{offers.error.message}
		</p>{/if}
	{#each settings.envoys as e (e.id)}
		{@const channels = channelsOf(e.id)}
		<section class="flex flex-col gap-2" data-envoy={e.id}>
			<p class="text-sm">
				{e.name}<span class="text-meta">
					· {t(e.audience === 'public' ? 'Public' : 'Private')}</span
				>
			</p>
			{#if channels.length > 0}
				{#each channels as channel (channel.id)}
					{@const offer = offers.current?.find((o) => o.integration === channel.integration)}
					<section class="flex flex-col gap-2" data-envoy-channel={channel.id}>
						{#if channels.length > 1}<p class="text-meta">{channel.name}</p>{/if}
						{#if offer === undefined}
							<Button
								size="sm"
								variant="ghost"
								class="self-start"
								onclick={() => onManage(channel.id)}>{t('Settings')}</Button
							>
						{:else}
							<ul class="flex flex-col gap-2">{@render connector(e, offer, channel)}</ul>
						{/if}
					</section>
				{/each}
			{:else}
				<ul class="flex flex-col gap-2">
					{#each (offers.current ?? []).filter((o) => o.workspace.length > 0) as o (o.integration)}
						{@render connector(e, o, undefined)}
					{/each}
				</ul>
			{/if}
		</section>
	{/each}
</Stack>
