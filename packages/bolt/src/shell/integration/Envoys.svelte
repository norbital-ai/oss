<!--
	Settings → Envoys: one row per envoy. Creation, provider pairing and the envoy's own fields stay in this one inline card;
	a paired envoy's channel opens from it. Programmatic setup opens the same controls; no dialog or record-sheet handoff.
-->
<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import { watch } from 'runed';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';
	import type { Json } from '../../decl/values.ts';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import {
		Button,
		Combobox,
		Form,
		Table,
		toast
	} from '@norbital-ai/ui';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from '../settings/data.ts';
	import EnvoyFields from './EnvoyFields.svelte';
	import { driverLabel, instanceMade, statusLabel } from './setup.ts';

	let {
		api,
		bolt,
		settings,
		t,
		locale,
		on_manage,
		reload,
		configuration = null
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		settings: Settings;
		t: (key: string) => string;
		locale: string;
		on_manage: (instance: string) => void;
		reload: () => Effect.Effect<void>;
		configuration?: SystemUiIntent | null;
	} = $props();

	type Envoy = Settings['envoys'][number];
	type Instance = Settings['instances'][number];
	type TableRow = {
		id: string;
		name: string;
		audience: string;
		provider: string;
		state: string;
	};
	// `sys_integration.status` is the host's stored JSON: only its `state` is read, decoded here
	const decodeState = Schema.decodeUnknownOption(Schema.Struct({ state: Schema.String }));
	const statusState = (status: Json) =>
		Option.getOrUndefined(Option.map(decodeState(status), (held) => held.state));
	const offers = observe_once(() =>
		api.integration_offers().pipe(Effect.map((all) => all.filter((o) => o.conversation)))
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
	let chosenProvider = $state<string | null>(null);
	const provider = $derived(chosenProvider ?? providers[0]?.integration ?? null);
	let creating = $state(false);
	let newName = $state('');
	watch(
		() => configuration?.key,
		() => {
			if (configuration?.request.capability !== 'envoy.create') return;
			newName = '';
			creating = true;
		}
	);
	let editing = $state<string | null>(null);
	const editing_envoy = $derived(settings.envoys.find((envoy) => envoy.id === editing));
	const editing_row = $derived(rows.find((row) => row.id === editing));
	let pending_envoy = $state<string | null>(null);

	const created = (envoy: Pick<Envoy, 'id' | 'name'>, integration: string) =>
		bolt
			.act({ 'sys_integration.create': [
				{
					integration,
					name: envoy.name,
					envoy: envoy.id
				}
			] })
			.pipe(
				Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.')))
			);

	const wire = (envoy: Pick<Envoy, 'id' | 'name'>, integration: string) => {
		if (pending_envoy !== null) return;
		pending_envoy = envoy.id;
		fork(created(envoy, integration).pipe(
			Effect.tap(() => reload()),
			Effect.tap((instance) => Effect.sync(() => on_manage(instance))),
			Effect.ensuring(Effect.sync(() => { pending_envoy = null; }))
		), (cause) => toast.error(cause.message));
	};

	const pair = (row: TableRow, integration: string) => {
		const envoy = envoyOf(row.id);
		const offer = providers.find((candidate) => candidate.integration === integration);
		if (envoy === undefined || offer === undefined) return;
		wire(envoy, offer.integration);
	};
</script>

{#if offers.error !== undefined}<p class="mb-3 text-sm text-destructive" role="alert">{offers.error.message}</p>{/if}
{#if !creating && editing_envoy === undefined}
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
	on_open={(row) => (editing = row.id)}
/>
{/if}

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
				aria-label={t('Provider')}
				placeholder={t(pending_envoy === row.id ? 'Creating channel…' : 'Choose provider')}
				disabled={pending_envoy !== null}
				options={providers.map((offer) => ({
					value: offer.integration,
					label: driverLabel(offer.driver),
					description: offer.description
				}))}
				value={null}
				on_change={(integration) => {
					if (integration !== null) pair(row, integration);
				}}
			/>
		</div>
	{:else}
		{row.provider}
	{/if}
{/snippet}

{#if creating}
	<section class="mt-4 space-y-4 rounded-lg border bg-card p-4" data-envoy-create>
		<div class="flex items-start justify-between gap-3">
			<div><h3 class="text-sm font-medium">{t('New envoy')}</h3><p class="mt-1 text-xs text-muted-foreground">{t('Choose who it helps and the channel it will answer on.')}</p></div>
			<Button variant="ghost" onclick={() => { creating = false; }}>{t('Cancel')}</Button>
		</div>
			<Form
				of="sys_envoy"
				mode="create"
				submit={t('Create envoy')}
				validate={({ policies }) =>
					Array.isArray(policies) && policies.length > 0
						? []
						: [{ field: 'policies', message: t('An envoy with no policy answers nobody.') }]}
				on_outcome={(outcome) => {
					if (outcome.kind !== 'committed') return;
					const record = outcome.records.find((r) => r.model === 'sys_envoy');
					const offer = providers.find((p) => p.integration === provider);
					creating = false;
					if (record !== undefined && offer !== undefined)
						wire({ id: record.id, name: newName }, offer.integration);
					else fork(reload());
				}}
			>
				{#snippet children()}
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
							on_change={(next) => (chosenProvider = next)}
						/>
					</div>
					<EnvoyFields policies={settings.policies} {t} on_name_change={(name) => { newName = name; }} />
				{/snippet}
			</Form>
	</section>
{/if}

{#if editing_envoy !== undefined}
	<section class="mt-4 space-y-4 rounded-lg border bg-card p-4" data-envoy-settings={editing_envoy.id}>
		<div class="flex items-center justify-between gap-3">
			<h3 class="text-sm font-medium">{editing_envoy.name}</h3>
			<Button variant="ghost" onclick={() => { editing = null; }}>{t('Back to envoys')}</Button>
		</div>
		{#if editing_row !== undefined}
			{@const channel = instanceOf(editing_row.id)}
			{#if channel === undefined}{@render providerCell({ row: editing_row })}
			{:else}
				<div class="flex items-center justify-between gap-3 text-sm">
					<span>{editing_row.provider} · {editing_row.state}</span>
					<Button variant="outline" onclick={() => on_manage(channel.id)}>{t('Manage')}</Button>
				</div>
			{/if}
		{/if}
		<Form of="sys_envoy" mode="update" id={editing_envoy.id} submit={t('Save')} on_outcome={() => fork(reload())}>
			<EnvoyFields policies={settings.policies} {t} active />
		</Form>
	</section>
{/if}
