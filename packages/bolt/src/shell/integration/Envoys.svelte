<!--
	Settings → Envoys: plugin-style cards driven by the same connection FSM as Integrations.
	Each envoy card shows its live channel status (Not yet installed → Not connected → Pairing → Connected / Disconnected / Error)
	and dynamic CTA. Envoy creation and channel installation use WAI-ARIA `create_radio_group` inset rows inside a Sheet,
	supporting attaching an existing unassigned workspace conversation channel or creating a new one (no duplicate channels,
	no card-in-card).
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { create_radio_group, watch } from '@norbital-ai/ui/behaviors';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import {
		Badge,
		Button,
		EmptyState,
		Form,
		Icon,
		Sheet,
		toast,
		type UiContext
	} from '@norbital-ai/ui';
	import { Cluster, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import IntegrationCard from '../../page/IntegrationCard.svelte';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from '../settings/data.ts';
	import EnvoyFields from './EnvoyFields.svelte';
	import { driverIcon, driverLabel, instanceMade } from './setup.ts';

	let {
		ctx,
		api,
		bolt,
		settings,
		t,
		locale,
		on_manage,
		reload,
		configuration = null
	}: {
		ctx: UiContext;
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

	const offers = observe_once(() =>
		api.integration_offers().pipe(Effect.map((all) => all.filter((o) => o.conversation)))
	);
	const offerOf = (integration: string) =>
		offers.current?.find((offer) => offer.integration === integration);
	const channelOf = (envoy: string): Instance | undefined =>
		settings.instances.find((instance) => instance.envoy === envoy);
	const providers = $derived((offers.current ?? []).filter((offer) => offer.workspace.length > 0));
	const conversationDefs = $derived(
		new Set(settings.integrations.filter((d) => d.conversation).map((d) => d.name))
	);
	const unassignedChannels = $derived(
		settings.instances.filter(
			(i) => i.owner === null && i.envoy === null && conversationDefs.has(i.integration)
		)
	);

	type ChannelOption =
		| {
				readonly key: string;
				readonly kind: 'existing';
				readonly instance: Instance;
				readonly driver: string;
				readonly label: string;
				readonly icon: string;
				readonly description: string;
		  }
		| {
				readonly key: string;
				readonly kind: 'new';
				readonly integration: string;
				readonly driver: string;
				readonly label: string;
				readonly icon: string;
				readonly description: string;
		  };

	const channelOptions = $derived<readonly ChannelOption[]>([
		...unassignedChannels.map((instance): ChannelOption => {
			const offer = offerOf(instance.integration);
			const driver = offer?.driver ?? instance.integration;
			return {
				key: `existing:${instance.id}`,
				kind: 'existing',
				instance,
				driver,
				label: instance.name,
				icon: offer?.workspace[0]?.icon ?? driverIcon(driver),
				description: `${t('Existing workspace connection')} · ${driverLabel(driver)}`
			};
		}),
		...providers.map((offer): ChannelOption => ({
			key: `new:${offer.integration}`,
			kind: 'new',
			integration: offer.integration,
			driver: offer.driver,
			label: driverLabel(offer.driver),
			icon: offer.workspace[0]?.icon ?? driverIcon(offer.driver),
			description: offer.description
		}))
	]);

	let chosenCreateKey = $state<string | undefined>(undefined);
	const createKey = $derived(chosenCreateKey ?? channelOptions[0]?.key);
	const createChannelRadio = create_radio_group({
		items: () => channelOptions.map((option) => option.key),
		value: () => createKey,
		orientation: 'both',
		on_change: (next) => {
			chosenCreateKey = next;
		},
		control: { id: 'envoy-create-channel', label: 'Choose a channel' }
	});

	let chosenAttachKey = $state<string | undefined>(undefined);
	const attachKey = $derived(chosenAttachKey ?? channelOptions[0]?.key);
	const attachChannelRadio = create_radio_group({
		items: () => channelOptions.map((option) => option.key),
		value: () => attachKey,
		orientation: 'both',
		disabled: () => pending_envoy !== null,
		on_change: (next) => {
			chosenAttachKey = next;
		},
		control: { id: 'envoy-attach-channel', label: 'Choose a channel' }
	});

	let creating = $state(false);
	let newName = $state('');
	let editing = $state<string | null>(null);
	let attaching = $state<Envoy | null>(null);
	let pending_envoy = $state<string | null>(null);

	const editing_envoy = $derived(settings.envoys.find((envoy) => envoy.id === editing));
	const editing_channel = $derived(
		editing_envoy === undefined ? undefined : channelOf(editing_envoy.id)
	);

	watch(
		() => configuration?.key,
		() => {
			if (configuration?.request.capability !== 'envoy.create') return;
			newName = '';
			chosenCreateKey = undefined;
			creating = true;
		}
	);

	const bindChannel = (envoy: Pick<Envoy, 'id' | 'name'>, option: ChannelOption) =>
		option.kind === 'existing'
			? bolt
					.act({
						'sys_integration.update': [
							{
								target: { id: option.instance.id, revision: option.instance.revision },
								set: { envoy: envoy.id }
							}
						]
					})
					.pipe(
						Effect.flatMap((outcome) =>
							outcome.kind === 'committed'
								? Effect.succeed(option.instance.id)
								: Effect.fail({ message: t('This connection could not be made.') })
						)
					)
			: bolt
					.act({
						'sys_integration.create': [
							{
								integration: option.integration,
								name: envoy.name,
								envoy: envoy.id
							}
						]
					})
					.pipe(
						Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.')))
					);

	const attachOption = (envoy: Pick<Envoy, 'id' | 'name'>, key: string | undefined, openAfter = false) => {
		const option = channelOptions.find((item) => item.key === key);
		if (option === undefined || pending_envoy !== null) return;
		pending_envoy = envoy.id;
		fork(
			bindChannel(envoy, option).pipe(
				Effect.tap(() => reload()),
				Effect.tap((instance) =>
					Effect.sync(() => {
						attaching = null;
						if (openAfter) on_manage(instance);
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						pending_envoy = null;
					})
				)
			),
			(cause) => toast.error(cause.message)
		);
	};

	const openCreate = () => {
		newName = '';
		chosenCreateKey = undefined;
		creating = true;
	};
</script>

{#snippet channelRadioList(radio: ReturnType<typeof create_radio_group>)}
	{#if channelOptions.length === 0}
		<p class="text-meta">{t('This host offers no provider for this integration’s driver.')}</p>
	{:else}
		<Grid
			minimum="compact"
			gap="sm"
			{...radio.root_attrs()}
			aria-label={t('Choose a channel')}
			data-envoy-channel-grid
		>
			{#each channelOptions as option (option.key)}
				{@const active = radio.value === option.key}
				<button
					{...radio.item_attrs(option.key)}
					{@attach radio.item(option.key)}
					data-channel-card={option.kind === 'new' ? option.integration : option.instance.id}
					class="flex min-w-0 items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 {active
						? 'border-border-active bg-surface-active ring-1 ring-ring'
						: 'border-border-control bg-surface-subtle hover:bg-surface-hover'}"
				>
					<span class="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-background">
						<Icon name={option.icon} class="size-4" />
					</span>
					<span class="min-w-0 flex-1">
						<span class="flex items-center justify-between gap-2">
							<span class="truncate text-sm font-medium text-foreground">
								{option.label}
							</span>
							{#if active}
								<Icon name="lucide:check" class="size-4 shrink-0 text-foreground" />
							{/if}
						</span>
						{#if option.description !== ''}
							<span class="line-clamp-2 text-meta">{option.description}</span>
						{/if}
					</span>
				</button>
			{/each}
		</Grid>
	{/if}
{/snippet}

<Stack gap="md" data-envoys-view>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<Stack gap="xs" class="min-w-0">
			<h3 class="text-sm font-medium text-foreground">{t('Envoys')}</h3>
			<p class="text-meta">
				{t('Each envoy answers on its channel. Create one, then pair its provider.')}
			</p>
		</Stack>
		<Button onclick={openCreate} data-new-envoy>
			<Icon name="lucide:plus" class="size-4" />{t('New envoy')}
		</Button>
	</div>

	{#if offers.error !== undefined}
		<p class="text-sm text-destructive" role="alert">{offers.error.message}</p>
	{/if}

	{#if settings.envoys.length === 0}
		<EmptyState
			variant="inset"
			icon="link"
			title={t('Envoys')}
			hint={t('Each envoy answers on its channel. Create one, then pair its provider.')}
		>
			<Button onclick={openCreate}>{t('New envoy')}</Button>
		</EmptyState>
	{:else}
		<Grid minimum="card" gap="md">
			{#each settings.envoys as envoy (envoy.id)}
				{@const channel = channelOf(envoy.id)}
				{@const offer = channel === undefined ? undefined : offerOf(channel.integration)}
				{@const channelDriver = offer?.driver ?? channel?.integration ?? 'chat'}
				<div class="min-w-0" data-envoy-channel={envoy.id}>
					<IntegrationCard
						driver={channelDriver}
						name={envoy.name}
						icon={channel === undefined ? 'lucide:bot' : offer?.workspace[0]?.icon ?? driverIcon(channelDriver)}
						description={envoy.task !== '' ? envoy.task : channel === undefined ? t('No channel yet') : offer?.description ?? ''}
						providers={offer?.workspace ?? []}
						providers_ready={!offers.loading}
						instance={channel === undefined
							? null
							: {
									id: channel.id,
									status: channel.status,
									active: envoy.active && channel.active
								}}
						client={(id) => api.integration(id)}
						create={channel === undefined
							? () =>
									Effect.sync(() => {
										chosenAttachKey = undefined;
										attaching = envoy;
										return null;
									})
							: undefined}
						on_manage={() => (editing = envoy.id)}
						on_state_change={(state, previous) => {
							if (
								previous !== undefined &&
								state !== previous &&
								(state === 'connected' || state === 'unpaired' || state === 'error')
							)
								fork(reload());
						}}
						{t}
						{locale}
					>
						{#snippet meta()}
							<Cluster gap="xs">
								<Badge variant="outline">
									{t(envoy.audience === 'public' ? 'Public' : 'Private')}
								</Badge>
								{#if channel !== undefined}
									<Badge variant="outline">{driverLabel(channelDriver)}</Badge>
								{/if}
								{#each envoy.policies.slice(0, 2) as policyName (policyName)}
									<Badge variant="outline">{policyName}</Badge>
								{/each}
								{#if envoy.policies.length > 2}
									<Badge variant="outline">+{envoy.policies.length - 2}</Badge>
								{/if}
							</Cluster>
						{/snippet}
					</IntegrationCard>
				</div>
			{/each}
		</Grid>
	{/if}
</Stack>

<Sheet
	open={creating}
	on_open_change={(next) => {
		creating = next;
	}}
	title={t('New envoy')}
	memory="settings-new-envoy"
>
	<div data-envoy-create>
		<Stack gap="lg">
			<Stack gap="sm">
				<span class="text-label">{t('Choose a channel')}</span>
				{@render channelRadioList(createChannelRadio)}
			</Stack>

			<Form
				{ctx}
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
					const selectedKey = createKey;
					creating = false;
					if (record !== undefined && selectedKey !== undefined)
						attachOption({ id: record.id, name: newName }, selectedKey, false);
					else fork(reload());
				}}
			>
				{#snippet children()}
					<EnvoyFields
						{ctx}
						policies={settings.policies}
						{t}
						on_name_change={(name) => {
							newName = name;
						}}
					/>
				{/snippet}
			</Form>
		</Stack>
	</div>
</Sheet>

<Sheet
	open={attaching !== null}
	on_open_change={(next) => {
		if (!next) attaching = null;
	}}
	title={attaching === null ? t('Install channel') : `${attaching.name} · ${t('Install channel')}`}
	memory="settings-envoy-channel"
>
	{#if attaching !== null}
		{@const targetEnvoy = attaching}
		<Stack gap="md">
			<p class="text-meta">{t('Choose a channel')}</p>
			{@render channelRadioList(attachChannelRadio)}
			{#if channelOptions.length > 0}
				<Cluster gap="sm" justify="end" class="border-t border-border pt-3">
					<Button
						disabled={attachKey === undefined || pending_envoy !== null}
						onclick={() => attachOption(targetEnvoy, attachKey, false)}
					>
						{t('Install channel')}
					</Button>
				</Cluster>
			{/if}
		</Stack>
	{/if}
</Sheet>

<Sheet
	open={editing_envoy !== undefined}
	on_open_change={(next) => {
		if (!next) editing = null;
	}}
	title={editing_envoy?.name ?? t('Envoy')}
	memory="settings-envoy-edit"
>
	{#if editing_envoy !== undefined}
		<div data-envoy-settings={editing_envoy.id}>
			<Stack gap="lg">
				<div class="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
					<Inline gap="sm" align="center" class="min-w-0">
						<span class="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-background">
							<Icon
								name={editing_channel === undefined
									? 'lucide:bot'
									: offerOf(editing_channel.integration)?.workspace[0]?.icon ??
										driverIcon(offerOf(editing_channel.integration)?.driver ?? editing_channel.integration)}
								class="size-4"
							/>
						</span>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium text-foreground">
								{editing_channel === undefined
									? t('No channel yet')
									: driverLabel(offerOf(editing_channel.integration)?.driver ?? editing_channel.integration)}
							</p>
							<p class="text-meta">{t('Channel')}</p>
						</div>
					</Inline>
					{#if editing_channel === undefined}
						<Button
							variant="outline"
							onclick={() => {
								chosenAttachKey = undefined;
								attaching = editing_envoy;
								editing = null;
							}}>{t('Install channel')}</Button
						>
					{:else}
						{@const channelId = editing_channel.id}
						<Button
							variant="outline"
							onclick={() => {
								editing = null;
								on_manage(channelId);
							}}>{t('Manage')}</Button
						>
					{/if}
				</div>

				<Form
					{ctx}
					of="sys_envoy"
					mode="update"
					id={editing_envoy.id}
					submit={t('Save')}
					on_outcome={() => {
						editing = null;
						fork(reload());
					}}
				>
					<EnvoyFields {ctx} policies={settings.policies} {t} active />
				</Form>
			</Stack>
		</div>
	{/if}
</Sheet>
