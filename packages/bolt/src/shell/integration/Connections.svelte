<!--
	A member's own connections, from the account menu: one connector per definition a member may connect personally
	(a mailbox, a phone, a calendar), each at most one instance the member owns — the data refuses a second. Connect makes
	it and pairs in one click; Disconnect unpairs and deletes it. Whether a member may is the workspace's grants.
-->
<script lang="ts">
	import { Effect, Schema, Stream } from 'effect';
	import { live, query } from '@norbital-ai/ui/effect';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import SystemPage from '../SystemPage.svelte';
	import Connector from './Connector.svelte';
	import { driverLabel, instanceMade } from './setup.ts';

	let {
		api,
		bolt,
		me,
		t,
		locale
	}: { api: ShellApi; bolt: ShellBolt; me: string; t: (key: string) => string; locale: string } =
		$props();

	const Owned = Schema.Struct({
		rows: Schema.Array(
			// a fresh row's status is absent until its link first reports
			Schema.Struct({
				id: Schema.String,
				integration: Schema.String,
				status: Schema.optionalKey(Schema.Json)
			})
		)
	});
	const offers = query(() =>
		api.integrationOffers().pipe(Effect.map((all) => all.filter((o) => o.personal.length > 0)))
	);
	const owned = live(() => {
		const source = bolt,
			member = me;
		return source
			.live(
				source.read('sys_integration', {
					where: { owner: { eq: member } },
					select: { integration: true, status: true },
					all: true
				})
			)
			.pipe(Stream.mapEffect((value) => Schema.decodeUnknownEffect(Owned)(value)));
	});
	const mine = (integration: string) => {
		const row = owned.current?.rows.find((r) => r.integration === integration);
		return row === undefined ? null : { id: row.id, status: row.status ?? null };
	};
	const created = (integration: string, name: string) =>
		bolt
			.act('sys_integration.create', { integration, name, owner: me })
			.pipe(
				Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.')))
			);
	const removed = (instance: string) =>
		bolt
			.act('sys_integration.delete', { target: instance })
			.pipe(Effect.map((outcome) => outcome.kind === 'committed'));
	const failure = $derived(offers.error?.message ?? owned.error?.message ?? null);
</script>

<SystemPage
	name="connections"
	error={failure}
	title={t('Connections')}
	description={t(
		'Your own accounts this workspace reads from: one of each. They only synchronize; nothing is sent from them.'
	)}
>
	<Stack gap="md" class="max-w-2xl">
		{#if offers.current === undefined}
			<p class="text-meta">{t('Loading…')}</p>
		{:else if offers.current.length === 0}
			<p class="text-meta">{t('This workspace offers nothing to connect.')}</p>
		{:else}
			<ul class="flex flex-col gap-2" data-connections>
				{#each offers.current as o (o.integration)}
					<Connector
						driver={o.driver}
						description={o.description}
						providers={o.personal}
						instance={mine(o.integration)}
						client={(instance) => api.integration(instance)}
						create={() => created(o.integration, driverLabel(o.driver))}
						remove={removed}
						{t}
						{locale}
					/>
				{/each}
			</ul>
		{/if}
	</Stack>
</SystemPage>
