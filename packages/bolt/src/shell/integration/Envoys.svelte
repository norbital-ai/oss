<!--
	Settings → Envoys: envoy cards driven by the shared connection FSM, with immediate post-create pairing,
	multi-envoy shared channel binding (`sys_envoy_channel`), and per-channel listening scope configuration
	(DMs by team/member/handle and groups/channels).
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { create_radio_group, watch } from '@norbital-ai/ui/behaviors';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import {
		Badge,
		Button,
		confirm_action,
		EmptyState,
		Form,
		Icon,
		Sheet,
		Tabs,
		toast,
		type UiContext
	} from '@norbital-ai/ui';
	import { Cluster, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { decodeStoredStatus } from '../../page/connection-fsm.ts';
	import IntegrationCard from '../../page/IntegrationCard.svelte';
	import IntegrationSetup from '../../page/IntegrationSetup.svelte';
	import {
		listeningScopeOf,
		scopeSummaryParts,
		type ListeningScope
	} from '../../engine/integrations/scope.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from '../settings/data.ts';
	import EnvoyFields from './EnvoyFields.svelte';
	import ListeningScopeEditor from './ListeningScopeEditor.svelte';
	import Setup from './Setup.svelte';
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
	type Binding = Settings['envoy_channels'][number];
	type GroupTrigger = 'disabled' | 'mention_or_reply' | 'all' | null;

	const offers = observe_once(() =>
		api.integration_offers().pipe(Effect.map((all) => all.filter((o) => o.conversation)))
	);
	const offerOf = (integration: string) =>
		offers.current?.find((offer) => offer.integration === integration);
	const instanceOf = (id: string): Instance | undefined =>
		settings.instances.find((instance) => instance.id === id);
	const bindingsOf = (envoyId: string): readonly Binding[] =>
		settings.envoy_channels.filter((ec) => ec.envoy === envoyId);
	const envoyNameOf = (envoyId: string): string =>
		settings.envoys.find((e) => e.id === envoyId)?.name ?? envoyId;
	const peerBindingsOn = (integrationId: string, excludeBindingId?: string): readonly Binding[] =>
		settings.envoy_channels.filter(
			(ec) => ec.integration === integrationId && ec.id !== excludeBindingId
		);
	const peerNamesOn = (integrationId: string, excludeEnvoyId?: string): readonly string[] =>
		settings.envoy_channels
			.filter((ec) => ec.integration === integrationId && ec.envoy !== excludeEnvoyId)
			.map((ec) => envoyNameOf(ec.envoy));

	const providers = $derived((offers.current ?? []).filter((offer) => offer.workspace.length > 0));
	const conversationDefs = $derived(
		new Set(settings.integrations.filter((d) => d.conversation).map((d) => d.name))
	);
	const workspaceChannels = $derived(
		settings.instances.filter((i) => i.owner === null && conversationDefs.has(i.integration))
	);
	const memberChoices = $derived(
		settings.members
			.filter((m): m is typeof m & { id: string } => typeof m['id'] === 'string')
			.map((m) => ({
				id: m['id'],
				name: typeof m['name'] === 'string' ? m['name'] : null,
				email: typeof m['email'] === 'string' ? m['email'] : null,
				phone: typeof m['phone'] === 'string' ? m['phone'] : null
			}))
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
				readonly shared: boolean;
		  }
		| {
				readonly key: string;
				readonly kind: 'new';
				readonly integration: string;
				readonly driver: string;
				readonly label: string;
				readonly icon: string;
				readonly description: string;
				readonly shared: false;
		  };

	const buildChannelOptions = (excludeIntegrationIds: ReadonlySet<string>): readonly ChannelOption[] => [
		...workspaceChannels
			.filter((instance) => !excludeIntegrationIds.has(instance.id))
			.map((instance): ChannelOption => {
				const offer = offerOf(instance.integration);
				const driver = offer?.driver ?? instance.integration;
				const stored = decodeStoredStatus(instance.status);
				const account = stored?.state === 'connected' && stored.account ? stored.account : null;
				const peers = peerNamesOn(instance.id);
				const parts = [
					peers.length > 0 ? t('Share channel') : t('Existing workspace connection'),
					driverLabel(driver),
					...(account !== null ? [account] : []),
					...(peers.length > 0
						? [t('Used by {names}').replace('{names}', peers.join(', '))]
						: [])
				];
				return {
					key: `existing:${instance.id}`,
					kind: 'existing',
					instance,
					driver,
					label: instance.name,
					icon: offer?.workspace[0]?.icon ?? driverIcon(driver),
					description: parts.join(' · '),
					shared: peers.length > 0
				};
			}),
		...providers.map((offer): ChannelOption => ({
			key: `new:${offer.integration}`,
			kind: 'new',
			integration: offer.integration,
			driver: offer.driver,
			label: driverLabel(offer.driver),
			icon: offer.workspace[0]?.icon ?? driverIcon(offer.driver),
			description: offer.description,
			shared: false
		}))
	];

	let creating = $state(false);
	let newName = $state('');
	let editing = $state<string | null>(null);
	let editTab = $state('settings');
	let attaching = $state<Envoy | null>(null);
	let pending_envoy = $state<string | null>(null);

	type PairingTarget = {
		readonly instanceId: string;
		readonly envoyId: string;
		readonly name: string;
		readonly driver: string;
		readonly icon: string;
	};
	let pairingTarget = $state<PairingTarget | null>(null);
	let pairFooter = $state<Snippet | null>(null);

	watch(
		() => pairingTarget?.instanceId ?? null,
		(next) => {
			if (next === null) pairFooter = null;
		}
	);

	const createChannelOptions = $derived(buildChannelOptions(new Set()));
	const attachChannelOptions = $derived(
		buildChannelOptions(
			new Set(attaching === null ? [] : bindingsOf(attaching.id).map((b) => b.integration))
		)
	);

	let chosenCreateKey = $state<string | undefined>(undefined);
	const createKey = $derived(chosenCreateKey ?? createChannelOptions[0]?.key);
	const createChannelRadio = create_radio_group({
		items: () => createChannelOptions.map((option) => option.key),
		value: () => createKey,
		orientation: 'both',
		on_change: (next) => {
			chosenCreateKey = next;
		},
		control: { id: 'envoy-create-channel', label: 'Choose a channel' }
	});

	let chosenAttachKey = $state<string | undefined>(undefined);
	const attachKey = $derived(chosenAttachKey ?? attachChannelOptions[0]?.key);
	const attachChannelRadio = create_radio_group({
		items: () => attachChannelOptions.map((option) => option.key),
		value: () => attachKey,
		orientation: 'both',
		disabled: () => pending_envoy !== null,
		on_change: (next) => {
			chosenAttachKey = next;
		},
		control: { id: 'envoy-attach-channel', label: 'Choose a channel' }
	});

	const editing_envoy = $derived(settings.envoys.find((envoy) => envoy.id === editing));
	const editing_bindings = $derived(
		editing_envoy === undefined ? [] : bindingsOf(editing_envoy.id)
	);

	// Per-binding listening scope draft state inside Manage envoy → Channels & scope.
	type ScopeDraft = {
		readonly scope: ListeningScope | null;
		readonly group_messages: GroupTrigger;
	};
	let scopeDrafts = $state<Record<string, ScopeDraft>>({});
	let savingBinding = $state<string | null>(null);

	watch(
		() => editing,
		() => {
			scopeDrafts = {};
		}
	);

	const storedDraftOf = (binding: Binding): ScopeDraft => ({
		scope: listeningScopeOf(binding.scope),
		group_messages: binding.group_messages
	});

	const currentDraftOf = (binding: Binding): ScopeDraft =>
		scopeDrafts[binding.id] ?? storedDraftOf(binding);

	const isDraftDirty = (binding: Binding): boolean => {
		const draft = scopeDrafts[binding.id];
		if (draft === undefined) return false;
		const base = storedDraftOf(binding);
		return (
			draft.group_messages !== base.group_messages ||
			JSON.stringify(draft.scope) !== JSON.stringify(base.scope)
		);
	};

	const setDraftScope = (binding: Binding, scope: ListeningScope | null) => {
		const cur = currentDraftOf(binding);
		scopeDrafts = { ...scopeDrafts, [binding.id]: { ...cur, scope } };
	};

	const setDraftGroupMessages = (binding: Binding, group_messages: GroupTrigger) => {
		const cur = currentDraftOf(binding);
		scopeDrafts = { ...scopeDrafts, [binding.id]: { ...cur, group_messages } };
	};

	const resetDraft = (binding: Binding) => {
		const next = { ...scopeDrafts };
		delete next[binding.id];
		scopeDrafts = next;
	};

	const saveBindingScope = (binding: Binding) => {
		if (savingBinding !== null) return;
		const draft = currentDraftOf(binding);
		savingBinding = binding.id;
		fork(
			bolt
				.act({
					'sys_envoy_channel.update': [
						{
							target: { id: binding.id, revision: binding.revision },
							set: {
								scope: draft.scope,
								group_messages: draft.group_messages
							}
						}
					]
				})
				.pipe(
					Effect.flatMap((outcome) =>
						outcome.kind === 'committed'
							? reload().pipe(
									Effect.tap(() =>
										Effect.sync(() => {
											resetDraft(binding);
											toast.success(t('Listening scope saved'));
										})
									)
								)
							: Effect.fail({ message: t('The request failed.') })
					),
					Effect.ensuring(
						Effect.sync(() => {
							savingBinding = null;
						})
					)
				),
			(cause) => toast.error(cause.message)
		);
	};

	const removeBinding = (binding: Binding, channelName: string) => {
		fork(
			confirm_action({
				title: t('Remove channel {name}?').replace('{name}', channelName),
				body: t('This envoy will stop answering on this channel. Other envoys and stored messages stay intact.'),
				confirm_label: t('Remove'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt
								.act({
									'sys_envoy_channel.delete': [
										{ target: { id: binding.id, revision: binding.revision } }
									]
								})
								.pipe(
									Effect.flatMap((outcome) =>
										outcome.kind === 'committed'
											? reload()
											: Effect.fail({ message: t('The request failed.') })
									)
								)
						: Effect.void
				)
			),
			(cause) => toast.error(cause.message)
		);
	};

	const deleteEnvoy = (envoy: Envoy) => {
		fork(
			confirm_action({
				title: t('Delete {name}?').replace('{name}', envoy.name),
				body: t('This removes the envoy and detaches it from its channels.'),
				confirm_label: t('Delete'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt
								.act({
									'sys_envoy.delete': [{ target: { id: envoy.id } }]
								})
								.pipe(
									Effect.flatMap((outcome) =>
										outcome.kind === 'committed'
											? Effect.sync(() => {
													if (editing === envoy.id) editing = null;
												}).pipe(Effect.andThen(reload()))
											: Effect.fail({ message: t('The request failed.') })
									)
								)
						: Effect.void
				)
			),
			(cause) => toast.error(cause.message)
		);
	};

	const peerClaimsFor = (binding: Binding) => {
		const peers = peerBindingsOn(binding.integration, binding.id);
		const claimedGroups = new Map<string, string[]>();
		const claimedAllGroupsBy: string[] = [];
		const claimedAllDmsBy: string[] = [];
		for (const peer of peers) {
			if (!peer.active) continue;
			const peerName = envoyNameOf(peer.envoy);
			const peerScope = listeningScopeOf(peer.scope);
			if (peerScope === null || peerScope.dm === undefined || peerScope.dm.mode === 'all') {
				claimedAllDmsBy.push(peerName);
			}
			if (peerScope === null || peerScope.groups === undefined || peerScope.groups.mode === 'all') {
				claimedAllGroupsBy.push(peerName);
			} else if (peerScope.groups.mode === 'selected') {
				for (const g of peerScope.groups.threads ?? []) {
					const existing = claimedGroups.get(g.id);
					if (existing !== undefined) existing.push(peerName);
					else claimedGroups.set(g.id, [peerName]);
				}
			}
		}
		return { claimedGroups, claimedAllGroupsBy, claimedAllDmsBy };
	};

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
		Effect.gen(function* () {
			const integrationId =
				option.kind === 'existing'
					? option.instance.id
					: yield* bolt
							.act({
								'sys_integration.create': [
									{
										integration: option.integration,
										name: envoy.name || option.label
									}
								]
							})
							.pipe(
								Effect.flatMap((outcome) =>
									instanceMade(outcome, t('This connection could not be made.'))
								)
							);
			const linkOutcome = yield* bolt.act({
				'sys_envoy_channel.create': [
					{
						envoy: envoy.id,
						integration: integrationId
					}
				]
			});
			if (linkOutcome.kind !== 'committed') {
				return yield* Effect.fail({
					message: t('This connection could not be made.')
				});
			}
			const connected =
				option.kind === 'existing' &&
				decodeStoredStatus(option.instance.status)?.state === 'connected';
			return {
				instanceId: integrationId,
				connected,
				name: option.kind === 'existing' ? option.instance.name : envoy.name || option.label,
				driver: option.driver,
				icon: option.icon
			};
		});

	const attachOption = (
		envoy: Pick<Envoy, 'id' | 'name'>,
		options: readonly ChannelOption[],
		key: string | undefined
	) => {
		const option = options.find((item) => item.key === key);
		if (option === undefined || pending_envoy !== null) return;
		pending_envoy = envoy.id;
		fork(
			bindChannel(envoy, option).pipe(
				Effect.tap(() => reload()),
				Effect.tap(({ instanceId, connected, name, driver, icon }) =>
					Effect.sync(() => {
						attaching = null;
						if (!connected) {
							editing = null;
							pairingTarget = { instanceId, envoyId: envoy.id, name, driver, icon };
						} else {
							editTab = 'channels';
							editing = envoy.id;
						}
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

{#snippet channelRadioList(
	options: readonly ChannelOption[],
	radio: ReturnType<typeof create_radio_group>
)}
	{#if options.length === 0}
		<p class="text-meta">{t('This host offers no provider for this integration’s driver.')}</p>
	{:else}
		<Grid
			minimum="compact"
			gap="sm"
			{...radio.root_attrs()}
			aria-label={t('Choose a channel')}
			data-envoy-channel-grid
		>
			{#each options as option (option.key)}
				{@const active = radio.value === option.key}
				<button
					{...radio.item_attrs(option.key)}
					{@attach radio.item(option.key)}
					data-channel-card={option.kind === 'new' ? option.integration : option.instance.id}
					class="flex min-w-0 items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 {active
						? 'border-ring bg-surface-active ring-1 ring-inset ring-ring'
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
				{@const bindings = bindingsOf(envoy.id)}
				{@const primaryBinding = bindings[0]}
				{@const channel = primaryBinding === undefined ? undefined : instanceOf(primaryBinding.integration)}
				{@const offer = channel === undefined ? undefined : offerOf(channel.integration)}
				{@const channelDriver = offer?.driver ?? channel?.integration ?? 'chat'}
				{@const shared =
					channel !== undefined && peerNamesOn(channel.id, envoy.id).length > 0}
				{@const scopeParts =
					primaryBinding === undefined
						? []
						: scopeSummaryParts(listeningScopeOf(primaryBinding.scope), channelDriver === 'email')}
				<div class="min-w-0" data-envoy-channel={envoy.id}>
					<IntegrationCard
						driver={channelDriver}
						name={envoy.name}
						icon={channel === undefined
							? 'lucide:bot'
							: (offer?.workspace[0]?.icon ?? driverIcon(channelDriver))}
						description={envoy.task !== ''
							? envoy.task
							: channel === undefined
								? t('No channel yet')
								: (offer?.description ?? '')}
						providers={offer?.workspace ?? []}
						providers_ready={!offers.loading}
						instance={channel === undefined
							? null
							: {
									id: channel.id,
									status: channel.status,
									active: envoy.active && channel.active && (primaryBinding?.active ?? true)
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
						on_manage={() => {
							editTab = 'settings';
							editing = envoy.id;
						}}
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
									<Badge variant="outline">
										{driverLabel(channelDriver)}{shared ? ` · ${t('Shared')}` : ''}
									</Badge>
								{/if}
								{#if bindings.length > 1}
									<Badge variant="outline">+{bindings.length - 1} {t('channels')}</Badge>
								{/if}
								{#each scopeParts as part (part)}
									<Badge variant="outline">{t(part)}</Badge>
								{/each}
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
	<div class="flex min-h-0 flex-1 flex-col" data-envoy-create>
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
				const selectedOptions = createChannelOptions;
				const createdName = newName;
				creating = false;
				if (record !== undefined && selectedKey !== undefined)
					attachOption({ id: record.id, name: createdName }, selectedOptions, selectedKey);
				else fork(reload());
			}}
		>
			{#snippet children()}
				<Stack gap="lg">
					<Stack gap="sm">
						<span class="text-label">{t('Choose a channel')}</span>
						{@render channelRadioList(createChannelOptions, createChannelRadio)}
					</Stack>

					<EnvoyFields
						{ctx}
						policies={settings.policies}
						{t}
						on_name_change={(name) => {
							newName = name;
						}}
					/>
				</Stack>
			{/snippet}
		</Form>
	</div>
</Sheet>

{#snippet attachFooter()}
	{#if attaching !== null && attachChannelOptions.length > 0}
		{@const targetEnvoy = attaching}
		<div class="ml-auto flex items-center gap-2">
			<Button variant="ghost" onclick={() => (attaching = null)}>{t('Cancel')}</Button>
			<Button
				disabled={attachKey === undefined || pending_envoy !== null}
				onclick={() => attachOption(targetEnvoy, attachChannelOptions, attachKey)}
			>
				{t('Install channel')}
			</Button>
		</div>
	{/if}
{/snippet}

<Sheet
	open={attaching !== null}
	on_open_change={(next) => {
		if (!next) attaching = null;
	}}
	title={attaching === null ? t('Install channel') : `${attaching.name} · ${t('Install channel')}`}
	memory="settings-envoy-channel"
	footer={attaching !== null && attachChannelOptions.length > 0 ? attachFooter : undefined}
>
	{#if attaching !== null}
		<Stack gap="md">
			<p class="text-meta">
				{t('Attach an existing channel to share it across envoys, or add a new provider.')}
			</p>
			{@render channelRadioList(attachChannelOptions, attachChannelRadio)}
		</Stack>
	{/if}
</Sheet>

{#if pairingTarget !== null}
	{@const target = pairingTarget}
	<IntegrationSetup
		client={api.integration(target.instanceId)}
		on_state_change={(state, previous) => {
			if (
				previous !== undefined &&
				state !== previous &&
				(state === 'connected' || state === 'unpaired' || state === 'error')
			) {
				fork(reload());
			}
			if (
				state === 'connected' &&
				previous !== undefined &&
				previous !== 'connected' &&
				previous !== 'reconnecting'
			) {
				pairingTarget = null;
				toast.success(t('Connected'));
				editTab = 'channels';
				editing = target.envoyId;
			}
		}}
		{t}
		{locale}
	>
		{#snippet children(source)}
			{@const isConnecting =
				source.status?.state === 'connecting' || source.status?.state === 'pairing'}
			{@const hasFooter = isConnecting || pairFooter !== null}
			{#snippet pairSheetFooter()}
				<Cluster gap="sm" align="center">
					{#if isConnecting}
						<Button
							variant="outline"
							disabled={source.busy}
							data-cancel-setup
							onclick={() => fork(source.unpair())}
						>
							{t('Cancel pairing')}
						</Button>
					{/if}
				</Cluster>
				{#if pairFooter !== null}
					{@render pairFooter()}
				{/if}
			{/snippet}
			<Sheet
				open={true}
				on_open_change={(next) => {
					if (!next) pairingTarget = null;
				}}
				title={target.name}
				memory={`integration-${target.driver}`}
				footer={hasFooter ? pairSheetFooter : undefined}
			>
				{#snippet header()}
					<Inline gap="sm" align="center" class="min-w-0">
						<span class="grid size-7 shrink-0 place-items-center rounded-control border border-border bg-background">
							<Icon name={target.icon} class="size-4" />
						</span>
						<h2 class="truncate text-heading">{target.name}</h2>
					</Inline>
				{/snippet}
				<div class="flex min-h-0 min-w-0 flex-1 flex-col" data-envoy-pair-sheet>
					<Setup
						{...source}
						controls={false}
						on_footer={(snippet) => (pairFooter = snippet)}
					/>
				</div>
			</Sheet>
		{/snippet}
	</IntegrationSetup>
{/if}

<Sheet
	open={editing_envoy !== undefined}
	on_open_change={(next) => {
		if (!next) editing = null;
	}}
	title={editing_envoy?.name ?? t('Envoy')}
	memory="settings-envoy-edit"
>
	{#if editing_envoy !== undefined}
		{@const envoy = editing_envoy}
		{#snippet settingsTab()}
			<div class="flex min-h-0 flex-1 flex-col">
				<Form
					{ctx}
					of="sys_envoy"
					mode="update"
					id={envoy.id}
					submit={t('Save')}
					on_outcome={() => {
						editing = null;
						fork(reload());
					}}
				>
					{#snippet children()}
						<EnvoyFields {ctx} policies={settings.policies} {t} active />
					{/snippet}
					{#snippet actions()}
						<Button
							type="button"
							variant="ghost"
							class="mr-auto text-destructive"
							onclick={() => deleteEnvoy(envoy)}
						>
							{t('Delete envoy')}
						</Button>
					{/snippet}
				</Form>
			</div>
		{/snippet}
		{#snippet channelsTab()}
			<Stack gap="md" class="pb-4" data-envoy-channels-tab>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<p class="text-meta">
						{t('Channels this envoy answers on, and which DMs or groups it listens to on each.')}
					</p>
					<Button
						variant="outline"
						onclick={() => {
							chosenAttachKey = undefined;
							attaching = envoy;
						}}
						data-add-envoy-channel
					>
						<Icon name="lucide:plus" class="size-4" />{t('Add channel')}
					</Button>
				</div>

				{#if editing_bindings.length === 0}
					<EmptyState
						variant="inset"
						icon="link"
						title={t('No channel yet')}
						hint={t('Attach an existing channel to share it across envoys, or add a new provider.')}
					>
						<Button
							onclick={() => {
								chosenAttachKey = undefined;
								attaching = envoy;
							}}
						>
							{t('Add channel')}
						</Button>
					</EmptyState>
				{:else}
					<Stack gap="md">
						{#each editing_bindings as binding (binding.id)}
							{@const channel = instanceOf(binding.integration)}
							{@const offer = channel === undefined ? undefined : offerOf(channel.integration)}
							{@const driver = offer?.driver ?? channel?.integration ?? 'chat'}
							{@const stored = decodeStoredStatus(channel?.status)}
							{@const connected = stored?.state === 'connected'}
							{@const peers = peerNamesOn(binding.integration, envoy.id)}
							{@const claims = peerClaimsFor(binding)}
							{@const draft = currentDraftOf(binding)}
							{@const dirty = isDraftDirty(binding)}
							<div
								class="flex flex-col gap-4 rounded-control border border-border bg-card p-4"
								data-envoy-binding={binding.id}
							>
								<div class="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 pb-3">
									<Inline gap="sm" align="center" class="min-w-0">
										<span class="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-background">
											<Icon name={offer?.workspace[0]?.icon ?? driverIcon(driver)} class="size-4" />
										</span>
										<div class="min-w-0">
											<div class="flex flex-wrap items-center gap-2">
												<p class="truncate text-sm font-medium text-foreground">
													{channel?.name ?? binding.integration}
												</p>
												<Badge variant="outline">{driverLabel(driver)}</Badge>
												<Badge variant="outline">
													{connected ? t('Connected') : t('Not connected')}
												</Badge>
											</div>
											{#if connected && stored?.account}
												<p class="truncate text-meta">{stored.account}</p>
											{/if}
											{#if peers.length > 0}
												<p class="text-xs text-muted-foreground">
													{t('Shared with {names}').replace('{names}', peers.join(', '))}
												</p>
											{/if}
										</div>
									</Inline>
									<Cluster gap="xs">
										{#if channel !== undefined && !connected}
											<Button
												variant="outline"
												onclick={() => {
													editing = null;
													pairingTarget = {
														instanceId: channel.id,
														envoyId: envoy.id,
														name: channel.name,
														driver,
														icon: offer?.workspace[0]?.icon ?? driverIcon(driver)
													};
												}}
											>
												{t('Pair')}
											</Button>
										{:else if channel !== undefined}
											<Button
												variant="outline"
												onclick={() => {
													editing = null;
													on_manage(channel.id);
												}}
											>
												{t('Connection')}
											</Button>
										{/if}
										<Button
											variant="ghost"
											class="text-destructive"
											onclick={() => removeBinding(binding, channel?.name ?? binding.integration)}
										>
											{t('Remove')}
										</Button>
									</Cluster>
								</div>

								<ListeningScopeEditor
									{driver}
									instance={binding.integration}
									client={api.integration(binding.integration)}
									value={draft.scope}
									on_change={(next) => setDraftScope(binding, next)}
									teams={settings.teams}
									members={memberChoices}
									audience={envoy.audience}
									group_messages={draft.group_messages}
									on_group_messages_change={(next) => setDraftGroupMessages(binding, next)}
									claimed_groups={claims.claimedGroups}
									claimed_all_groups_by={claims.claimedAllGroupsBy}
									claimed_all_dms_by={claims.claimedAllDmsBy}
									disabled={savingBinding === binding.id}
									{t}
								/>

								<Cluster gap="sm" justify="end" class="border-t border-border/70 pt-3">
									{#if dirty}
										<Button
											variant="ghost"
											disabled={savingBinding === binding.id}
											onclick={() => resetDraft(binding)}
										>
											{t('Reset')}
										</Button>
									{/if}
									<Button
										disabled={!dirty || savingBinding === binding.id}
										onclick={() => saveBindingScope(binding)}
										data-save-binding-scope
									>
										{savingBinding === binding.id ? t('Saving…') : t('Save scope')}
									</Button>
								</Cluster>
							</div>
						{/each}
					</Stack>
				{/if}
			</Stack>
		{/snippet}
		<div class="flex min-h-0 flex-1 flex-col" data-envoy-settings={envoy.id}>
			<Tabs
				orientation="horizontal"
				bind:value={editTab}
				tabs={[
					{
						name: 'settings',
						title: t('Settings'),
						icon: 'lucide:sliders-horizontal',
						body: settingsTab,
						keep_alive: true
					},
					{
						name: 'channels',
						title: t('Channels & scope'),
						icon: 'concept:integrations',
						body: channelsTab,
						keep_alive: true
					}
				]}
			/>
		</div>
	{/if}
</Sheet>
