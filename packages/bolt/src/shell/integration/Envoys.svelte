<!--
	Settings → Envoys: one row per envoy. Step one creates the envoy and chooses its channel provider; step two pairs
	that channel with the provider credentials. A toast/table row opens the same pairing card for an unpaired channel.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import {
		Button,
		Combobox,
		Dialog,
		Field,
		Form,
		Input,
		Table,
		Textarea,
		toast
	} from '@norbital-ai/ui';
	import type { IntegrationOffer } from '../../protocol/instance-status.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from '../settings/data.ts';
	import Connector from './Connector.svelte';
	import { driverLabel, instanceMade, statusLabel } from './setup.ts';

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
		reload: () => Effect.Effect<void>;
	} = $props();

	type Envoy = Settings['envoys'][number];
	type Instance = Settings['instances'][number];
	type WireOffer = Pick<IntegrationOffer, 'integration' | 'driver' | 'description' | 'workspace'>;
	type TableRow = {
		id: string;
		name: string;
		audience: string;
		provider: string;
		state: string;
	};
	const statusState = (status: unknown) =>
		typeof status === 'object' &&
		status !== null &&
		'state' in status &&
		typeof status.state === 'string'
			? status.state
			: undefined;
	const offers = observeOnce(() =>
		api.integrationOffers().pipe(Effect.map((all) => all.filter((o) => o.conversation)))
	);
	const offerOf = (integration: string) =>
		offers.current?.find((offer) => offer.integration === integration);
	const channelOf = (envoy: string): Instance | undefined =>
		settings.instances.find((instance) => instance.envoy === envoy);
	const stateOf = (channel: Instance | undefined) => {
		if (channel === undefined) return t('Not paired');
		const state = statusState(channel.status);
		return statusLabel(
			{
				state: state === 'connected' || state === 'error' ? state : 'unpaired',
				stored: false
			},
			t
		);
	};
	const rows = $derived<TableRow[]>(
		settings.envoys.map((envoy) => {
			const channel = channelOf(envoy.id);
			const offer = channel === undefined ? undefined : offerOf(channel.integration);
			return {
				id: envoy.id,
				name: envoy.name,
				audience: t(envoy.audience === 'public' ? 'Public' : 'Private'),
				provider: channel === undefined ? '—' : driverLabel(offer?.driver ?? channel.integration),
				state: stateOf(channel)
			};
		})
	);
	const envoyOf = (id: string) => settings.envoys.find((envoy) => envoy.id === id);
	const instanceOf = (id: string) => settings.instances.find((instance) => instance.envoy === id);
	const providers = $derived((offers.current ?? []).filter((offer) => offer.workspace.length > 0));
	/** The provider chosen in the create step; the first available until the viewer changes it. */
	let provider = $state<string | null>(null);
	$effect(() => {
		if (provider === null && providers[0] !== undefined) provider = providers[0].integration;
	});
	let creating = $state(false);
	let newName = $state('');
	let wiring = $state<{ envoy: Pick<Envoy, 'id' | 'name'>; offer: WireOffer; instance: string } | null>(
		null
	);

	const created = (envoy: Pick<Envoy, 'id' | 'name'>, integration: string) =>
		bolt
			.act('sys_integration.create', [
				{
					integration,
					name: envoy.name,
					envoy: envoy.id
				}
			])
			.pipe(Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.'))));

	const wire = (envoy: Pick<Envoy, 'id' | 'name'>, offer: WireOffer) => {
		fork(
			created(envoy, offer.integration).pipe(
				Effect.tap((instance) =>
					Effect.sync(() => {
						wiring = { envoy, offer, instance };
					})
				),
				Effect.tap(() => reload())
			),
			(cause) => toast.error(cause.message)
		);
	};
	const open = (row: TableRow) => {
		const envoy = envoyOf(row.id);
		if (envoy === undefined) return;
		const instance = instanceOf(row.id);
		if (instance === undefined) return;
		const offer = offerOf(instance.integration);
		if (offer === undefined) {
			toast.error(t('This channel’s provider is not available on this host.'));
			return;
		}
		wiring = { envoy, offer, instance: instance.id };
	};
	const pair = (row: TableRow, integration: string) => {
		const envoy = envoyOf(row.id);
		const offer = providers.find((candidate) => candidate.integration === integration);
		if (envoy === undefined || offer === undefined) return;
		wire(envoy, offer);
	};
	const removed = (instance: string) =>
		(settings.instances.find((i) => i.id === instance)?.named === true
			? Effect.succeed(false)
			: bolt
					.act('sys_integration.delete', [{ target: instance }])
					.pipe(Effect.map((outcome) => outcome.kind === 'committed'))
		).pipe(Effect.tap(() => reload()));
	const closeWiring = () => {
		wiring = null;
		fork(reload());
	};
</script>

<Table
	of={rows}
	columns={[
		{ field: 'name', label: t('Name'), cell: nameCell },
		{ field: 'audience', label: t('Audience') },
		{ field: 'provider', label: t('Provider'), cell: providerCell },
		{ field: 'state', label: t('Connected') }
	]}
	key="settings-envoys"
	toolbar={{
		title: t('Envoys'),
		description: t('Each envoy answers on its channel. Create one, then pair its provider.'),
		select: false,
		export: false,
		delete: false,
		new: () => {
			newName = '';
			creating = true;
		}
	}}
	onOpen={open}
/>

{#snippet nameCell({ row }: { row: TableRow })}
	<span data-envoy-channel={row.id}>{row.name}</span>
{/snippet}

{#snippet providerCell({ row }: { row: TableRow })}
	{@const instance = instanceOf(row.id)}
	{#if instance === undefined}
		<div
			class="min-w-36"
			role="presentation"
			onclick={(event: MouseEvent) => event.stopPropagation()}
		>
			<Combobox
				size="sm"
				aria-label={t('Provider')}
				placeholder={t('Choose provider')}
				options={providers.map((offer) => ({
					value: offer.integration,
					label: driverLabel(offer.driver),
					description: offer.description
				}))}
				value={null}
				onChange={(integration) => {
					if (integration !== null) pair(row, integration);
				}}
			/>
		</div>
	{:else}
		{row.provider}
	{/if}
{/snippet}

<Dialog.Root
	bind:open={creating}
	onOpenChange={(open) => {
		if (!open) creating = false;
	}}
>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t('New envoy')}</Dialog.Title>
			<Dialog.Description>
				{t('Step 1 of 2: the envoy’s details and the channel it will answer on.')}
			</Dialog.Description>
		</Dialog.Header>
		{#if creating}
			<Form
				of="sys_envoy"
				mode="create"
				submit={t('Create envoy')}
				onOutcome={(outcome) => {
					if (outcome.kind !== 'committed') return;
					const record = outcome.records.find((r) => r.model === 'sys_envoy');
					const offer = providers.find((p) => p.integration === provider);
					creating = false;
					if (record !== undefined && offer !== undefined)
						wire({ id: record.id, name: newName }, offer);
					else fork(reload());
				}}
			>
				{#snippet children()}
					<Field name="name" label={t('Name')}>
						{#snippet editor(field)}
							<Input
								id={field.id}
								value={newName}
								disabled={field.disabled}
								oninput={(event) => {
									newName = event.currentTarget.value;
									field.onChange(newName === '' ? null : newName);
								}}
							/>
						{/snippet}
					</Field>
					<Field name="audience" label={t('Audience')} />
					<div class="grid gap-1">
						<span class="text-xs font-medium text-muted-foreground">{t('Channel')}</span>
						<Combobox
							aria-label={t('Channel')}
							options={providers.map((offer) => ({
								value: offer.integration,
								label: driverLabel(offer.driver),
								description: offer.description
							}))}
							value={provider}
							onChange={(next) => (provider = next)}
						/>
					</div>
					<Field name="task" label={t('Supplementary prompt')}>
						{#snippet editor(field)}
							<Textarea
								id={field.id}
								rows={4}
								value={typeof field.value === 'string' ? field.value : ''}
								disabled={field.disabled}
								oninput={(event) =>
									field.onChange(
										event.currentTarget.value === '' ? null : event.currentTarget.value
									)}
							/>
						{/snippet}
					</Field>
					<Field name="policies" label={t('Policies')}>
						{#snippet editor(field)}
							<Combobox
								id={field.id}
								multiple
								aria-label={t('Policies')}
								placeholder={t('Choose policies')}
								options={settings.policies.map((policy) => ({
									value: policy,
									label: policy
								}))}
								value={Array.isArray(field.value) ? field.value.map(String) : []}
								onChange={field.onChange}
								disabled={field.disabled}
							/>
						{/snippet}
					</Field>
					<div class="grid gap-3 sm:grid-cols-2">
						<Field name="group_messages" label={t('Group messages')} />
						<Field name="delegation" label={t('Delegation')} />
						<Field name="dm" label={t('Direct messages')} />
					</div>
				{/snippet}
			</Form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={wiring !== null}
	onOpenChange={(open) => {
		if (!open) closeWiring();
	}}
>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{wiring === null ? t('Pair channel') : wiring.envoy.name}</Dialog.Title>
			<Dialog.Description>
				{t('Pair the provider. Its credentials are stored by the host and never shown as a field.')}
			</Dialog.Description>
		</Dialog.Header>
		{#if wiring !== null}
			<ul class="flex w-full min-w-0 flex-col gap-2">
				{@render connector(wiring.envoy, wiring.offer, wiring.instance)}
			</ul>
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#snippet connector(envoy: Pick<Envoy, 'id' | 'name'>, offer: WireOffer, instance: string)}
	{@const channel = settings.instances.find((i) => i.id === instance)}
	<Connector
		driver={offer.driver}
		description={offer.description}
		providers={offer.workspace}
		instance={{ id: instance, status: channel?.status ?? null, active: channel?.active ?? true }}
		client={(id) => api.integration(id)}
		create={() => Effect.succeed(instance)}
		remove={removed}
		onManage={(id) => {
			wiring = null;
			onManage(id);
		}}
		{t}
		{locale}
	/>
{/snippet}
