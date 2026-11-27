<!-- The administrator's workspace connections or envoy channels, using the shared plugin-card FSM and admin detail tabs. -->
<script lang="ts">
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import type { Value } from '@norbital-ai/store/kind';
	import { create_radio_group, watch } from '@norbital-ai/ui/behaviors';
	import {
		Badge,
		Button,
		confirm_action,
		EmptyState,
		Field,
		Form,
		format,
		Icon,
		open_record,
		Sheet,
		Spinner,
		TableSkeleton,
		Tabs,
		type FieldEditor,
		type UiContext
	} from '@norbital-ai/ui';
	import { Cluster, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import IntegrationCard from '../../page/IntegrationCard.svelte';
	import ClassifierEditor from './ClassifierEditor.svelte';
	import ConfigurationFields from './ConfigurationFields.svelte';
	import ConnectionHistory from './ConnectionHistory.svelte';
	import ListeningScopeEditor from './ListeningScopeEditor.svelte';
	import { classifierConfigOf, listeningScopeOf } from '../../engine/integrations/scope.ts';
	import { humanise_word } from '../i18n.ts';
	import {
		driverIcon,
		driverLabel,
		instanceMade,
		workspaceConnection,
		type IntegrationSetupEntry
	} from './setup.ts';
	import type { Json } from '../../decl/values.ts';
	import type { Settings } from '../settings/data.ts';
	import { page_context, type ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import Envoys from './Envoys.svelte';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';

	let {
		ctx,
		api,
		bolt,
		t,
		settings,
		locale,
		integration_setups,
		reload,
		connections = false,
		configuration = null
	}: {
		ctx: UiContext;
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		settings: Settings;
		locale: string;
		/** The definitions' own setup components (`integration/<name>/+integration.svelte`), drawn in place of the generic setup. */
		integration_setups?: { readonly [integration: string]: IntegrationSetupEntry } | undefined;
		/** Re-reads the settings after a write. */
		reload: () => Effect.Effect<void>;
		connections?: boolean;
		configuration?: SystemUiIntent | null;
	} = $props();

	type Instance = Settings['instances'][number];
	type Definition = Settings['integrations'][number];
	const str = (v: Value | undefined) => (v === null || v === undefined ? '' : String(v));
	const when = (v: Value | undefined) =>
		typeof v === 'string' && v !== ''
			? format({ kind: 'instant' }, v, { locale: bolt.locale })
			: '—';
	const definition = (name: Value | undefined): Definition | undefined =>
		settings.integrations.find((d) => d.name === name);
	const declaredIntegrations = $derived(
		new Set(settings.integrations.filter((d) => d.declared).map((d) => d.name))
	);
	const boundEnvoysOf = (instanceId: string) =>
		settings.envoy_channels
			.filter((ec) => ec.integration === instanceId)
			.map((ec) => settings.envoys.find((e) => e.id === ec.envoy))
			.filter((e): e is NonNullable<typeof e> => e !== undefined);
	/** Programmatic workspace connections (`owner === null`, excluding envoy-only channels). */
	const workspaceInstances = $derived(
		settings.instances.filter((i) =>
			workspaceConnection(i, settings.envoy_channels, declaredIntegrations)
		)
	);
	/** Predeclared workspace definitions (custom `src/integration/*` + `workspace({ connections })`), custom first. */
	const workspaceDefinitions = $derived(
		settings.integrations
			.filter((d) => d.declared)
			.toSorted((a, b) => Number(b.custom === true) - Number(a.custom === true) || a.name.localeCompare(b.name))
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
	const installedDefinitions = $derived(new Set(workspaceInstances.map((i) => i.integration)));
	const uninstalledDefinitions = $derived(
		workspaceDefinitions.filter((d) => !installedDefinitions.has(d.name))
	);
	const memberName = (id: string | null) => {
		const u = settings.members.find((x) => x['id'] === id);
		return str(u?.['name']) || str(u?.['email']) || str(id);
	};
	const hasRequiredConfig = (def: Definition) =>
		Object.values(def.configuration).some((field) => field.optional !== true && field.default === undefined);

	// ── the open instance: its detail view, and creation sheet ──
	let open = $state<string | null>(null);
	let creating = $state(false);
	let creating_definition = $state<string | null>(null);
	let pickedNewDef = $state<string | undefined>(undefined);
	const chosenNewDef = $derived(pickedNewDef ?? workspaceDefinitions[0]?.name);
	const newDefRadio = create_radio_group({
		items: () => workspaceDefinitions.map((item) => item.name),
		value: () => chosenNewDef,
		orientation: 'both',
		on_change: (next) => {
			pickedNewDef = next;
		},
		control: { id: 'settings-new-connection-definition', label: 'Choose integration' }
	});
	const new_definition = $derived(
		workspaceDefinitions.find((item) => item.name === creating_definition)
	);
	let create_busy = $state(false);
	let create_error = $state<string | null>(null);

	/** A definition's own create step makes the row as the generic form does, then opens its management view. */
	const create_connection = (integration: string) => (input: { name: string; configuration?: Json }) =>
		Effect.suspend(() => {
			create_busy = true;
			create_error = null;
			return bolt
				.act({
					'sys_integration.create': [
						{
							integration,
							name: input.name,
							...(input.configuration === undefined ? {} : { configuration: input.configuration })
						}
					]
				})
				.pipe(
					Effect.flatMap((outcome) => instanceMade(outcome, t('This connection could not be made.'))),
					Effect.tap((id) =>
						Effect.sync(() => {
							creating = false;
							creating_definition = null;
							open = id;
						})
					),
					Effect.andThen(reload()),
					Effect.catch((cause) =>
						Effect.sync(() => {
							create_error = cause.message;
						})
					),
					Effect.ensuring(
						Effect.sync(() => {
							create_busy = false;
						})
					)
				);
		});

	/** One-click install when no required config or custom create step exists; otherwise opens the create sheet preselected. */
	const installDefinition = (def: Definition) =>
		Effect.gen(function* () {
			if (hasRequiredConfig(def)) {
				creating_definition = def.name;
				creating = true;
				return null;
			}
			const entry = integration_setups?.[def.name];
			if (entry !== undefined) {
				const companion = yield* Effect.tryPromise(() => entry.load()).pipe(
					Effect.catch(() => Effect.succeed(undefined))
				);
				if (companion?.configuration_tab === undefined && companion?.create !== undefined) {
					creating_definition = def.name;
					creating = true;
					return null;
				}
			}
			const outcome = yield* bolt.act({
				'sys_integration.create': [
					{
						integration: def.name,
						name: def.custom === true ? t(humanise_word(def.name)) : driverLabel(def.driver)
					}
				]
			});
			const createdId = yield* instanceMade(outcome, t('This connection could not be made.'));
			yield* reload();
			return createdId;
		});

	const resumeInstance = (i: Instance) =>
		bolt
			.act({
				'sys_integration.update': [{ target: { id: i.id, revision: i.revision }, set: { active: true } }]
			})
			.pipe(
				Effect.flatMap((outcome) =>
					outcome.kind === 'committed'
						? reload()
						: Effect.fail({ message: t('This connection could not be made.') })
				)
			);

	const deleteInstanceDirect = (i: Instance) =>
		bolt.act({ 'sys_integration.delete': [{ target: { id: i.id, revision: i.revision } }] }).pipe(
			Effect.flatMap((outcome) =>
				outcome.kind === 'committed'
					? Effect.sync(() => {
							if (open === i.id) open = null;
						}).pipe(Effect.andThen(reload()))
					: Effect.fail({ message: t('The request failed.') })
			)
		);

	let configured = $state<string | null>(null);
	watch([() => configuration, () => settings], ([intent, current]) => {
		if (intent?.request.capability === 'integration.create' && connections && configured !== intent.key) {
			configured = intent.key;
			creating_definition = null;
			creating = true;
			return;
		}
		if (
			intent === null ||
			configured === intent.key ||
			intent.request.capability !== 'integration.manage'
		)
			return;
		const record = intent.request.record;
		const declared = new Set(current.integrations.filter((d) => d.declared).map((d) => d.name));
		if (
			current.instances.some(
				(instance) =>
					instance.id === record &&
					workspaceConnection(instance, current.envoy_channels, declared) === connections
			)
		) {
			configured = intent.key;
			open = record;
		}
	});
	const current = $derived(settings.instances.find((i) => i.id === open));
	const offers = observe_once(() => api.integration_offers());
	const offerOf = (integration: string) =>
		offers.current?.find((item) => item.integration === integration);
	const setup_entry = $derived(current === undefined ? undefined : integration_setups?.[current.integration]);
	const setup_module = $derived(setup_entry?.load());
	let active_tab = $state('connection');
	let error = $state<string | null>(null);
	watch(
		() => open,
		() => {
			error = null;
			active_tab = 'connection';
		}
	);
	function remove(i: Instance): void {
		fork(
			confirm_action({
				title: t('Delete {name}?').replace('{name}', i.name),
				body: t('Its credentials, sync progress, conversations and messages are deleted with it.'),
				confirm_label: t('Delete'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt.act({ 'sys_integration.delete': [{ target: { id: i.id, revision: i.revision } }] }).pipe(
								Effect.tap((outcome) =>
									Effect.sync(() => {
										if (outcome.kind === 'committed') open = null;
									})
								),
								Effect.andThen(reload())
							)
						: Effect.void
				)
			),
			(cause) => {
				error = cause.message;
			}
		);
	}

	const syncHealth = observe_once(() => {
		const instance = current;
		return instance === undefined || definition(instance.integration)?.syncs !== true
			? null
			: api.instance_sync_health(instance.id);
	});
	let replaying = $state<string | null>(null);
	const dead_letters = observe_once(() =>
		current && definition(current.integration)?.syncs === true
			? api.instance_sync_dead_letters(current.id)
			: null
	);
	let retiring = $state<string | null>(null);
	function retireWrite(id: string): void {
		const instance = current?.id;
		if (instance === undefined || retiring !== null) return;
		fork(
			confirm_action({
				title: t('Retire rejected write?'),
				body: t(
					'This stops retrying this saved write and releases later changes for the record. Confirm that its remote state is understood.'
				),
				confirm_label: t('Retire write'),
				cancel_label: t('Cancel')
			}).pipe(
				Effect.flatMap((confirmed) => {
					if (!confirmed) return Effect.void;
					retiring = id;
					return api.retire_instance_sync(instance, id).pipe(
						Effect.andThen(dead_letters.refetch()),
						Effect.andThen(syncHealth.refetch()),
						Effect.ensuring(
							Effect.sync(() => {
								retiring = null;
							})
						)
					);
				})
			),
			(cause) => {
				error = cause.message;
			}
		);
	}
	function replaySync(): void {
		const instance = current?.id;
		if (instance === undefined || replaying === instance) return;
		replaying = instance;
		error = null;
		fork(
			api.replay_instance_sync(instance).pipe(
				Effect.andThen(dead_letters.refetch()),
				Effect.andThen(syncHealth.refetch()),
				Effect.ensuring(
					Effect.sync(() => {
						if (replaying === instance) replaying = null;
					})
				)
			),
			(cause) => {
				if (open === instance) error = cause.message;
			}
		);
	}

</script>

{#if current === undefined}
	{#if connections}
		<Stack gap="lg" data-workspace-connections>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<Stack gap="xs" class="min-w-0">
					<h3 class="text-sm font-medium text-foreground">{t('Connections')}</h3>
					<p class="text-meta">
						{t('Choose an integration, name the account, then pair its provider.')}
					</p>
				</Stack>
				<Button
					variant="outline"
					onclick={() => {
						creating_definition = null;
						pickedNewDef = undefined;
						create_error = null;
						creating = true;
					}}
				>
					<Icon name="lucide:plus" class="size-4" />{t('Add connection')}
				</Button>
			</div>

			{#if offers.error !== undefined}
				<p role="alert" class="text-sm text-destructive">{offers.error.message}</p>
			{/if}

			{#if workspaceInstances.length === 0 && uninstalledDefinitions.length === 0}
				<EmptyState
					variant="inset"
					icon="link"
					title={t('Connections')}
					hint={t('Choose an integration, name the account, then pair its provider.')}
				/>
			{:else}
				{#if workspaceInstances.length > 0}
					<Stack gap="sm">
						<h4 class="text-overline">{t('Installed')}</h4>
						<Grid minimum="card" gap="md">
							{#each workspaceInstances as instance (instance.id)}
								{@const def = definition(instance.integration)}
								{@const offer = offerOf(instance.integration)}
								{@const sharedEnvoys = boundEnvoysOf(instance.id)}
								{#snippet envoyMeta()}
									<Cluster gap="xs">
										<Badge variant="outline">
											{t('Shared with {names}').replace(
												'{names}',
												sharedEnvoys.map((e) => e.name).join(', ')
											)}
										</Badge>
									</Cluster>
								{/snippet}
								<IntegrationCard
									driver={def?.driver ?? instance.integration}
									name={instance.name}
									description={def?.description ?? ''}
									providers={offer?.workspace ?? []}
									providers_ready={!offers.loading}
									instance={{ id: instance.id, status: instance.status, active: instance.active }}
									client={(id) => api.integration(id)}
									setup={integration_setups?.[instance.integration]}
									meta={sharedEnvoys.length > 0 ? envoyMeta : undefined}
									on_manage={() => (open = instance.id)}
									on_resume={() => resumeInstance(instance)}
									on_delete={() => deleteInstanceDirect(instance)}
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
								/>
							{/each}
						</Grid>
					</Stack>
				{/if}

				{#if uninstalledDefinitions.length > 0}
					<Stack gap="sm">
						<h4 class="text-overline">{t('Available')}</h4>
						<Grid minimum="card" gap="md">
							{#each uninstalledDefinitions as def (def.name)}
								{@const offer = offerOf(def.name)}
								<IntegrationCard
									driver={def.driver}
									name={def.custom === true ? t(humanise_word(def.name)) : driverLabel(def.driver)}
									description={def.description}
									providers={offer?.workspace ?? []}
									providers_ready={!offers.loading}
									instance={null}
									client={(id) => api.integration(id)}
									create={() => installDefinition(def)}
									setup={integration_setups?.[def.name]}
									{t}
									{locale}
								/>
							{/each}
						</Grid>
					</Stack>
				{/if}
			{/if}
		</Stack>

		{#snippet newConnectionFooter()}
			{#if new_definition === undefined && workspaceDefinitions.length > 0}
				<div class="ml-auto flex items-center gap-2">
					<Button variant="ghost" onclick={() => (creating = false)}>{t('Cancel')}</Button>
					<Button
						disabled={chosenNewDef === undefined}
						onclick={() => {
							if (chosenNewDef !== undefined) {
								creating_definition = chosenNewDef;
								create_error = null;
							}
						}}
					>
						{t('Continue')}
					</Button>
				</div>
			{/if}
		{/snippet}
		<Sheet
			open={creating}
			on_open_change={(next) => {
				creating = next;
				if (!next) {
					creating_definition = null;
					pickedNewDef = undefined;
					create_error = null;
				}
			}}
			title={t('New connection')}
			memory="settings-new-connection"
			footer={new_definition === undefined && workspaceDefinitions.length > 0
				? newConnectionFooter
				: undefined}
		>
			<div class="flex min-h-0 flex-1 flex-col" data-connection-create>
				<Stack gap="md" class="min-h-0 flex-1">
					{#if new_definition === undefined}
						<p class="text-meta">
							{t('Choose an integration, name the account, then pair its provider.')}
						</p>
						<Grid
							minimum="compact"
							gap="sm"
							{...newDefRadio.root_attrs()}
							aria-label={t('Choose integration')}
						>
							{#each workspaceDefinitions as item (item.name)}
								{@const active = newDefRadio.value === item.name}
								<button
									{...newDefRadio.item_attrs(item.name)}
									{@attach newDefRadio.item(item.name)}
									class="flex min-w-0 items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring {active
										? 'border-border-active bg-surface-active ring-1 ring-ring'
										: 'border-border-control bg-surface-subtle hover:bg-surface-hover'}"
									data-connection-choice={item.name}
								>
									<span class="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-background">
										<Icon name={driverIcon(item.driver)} class="size-4" />
									</span>
									<span class="min-w-0 flex-1">
										<span class="flex items-center justify-between gap-2">
											<span class="truncate text-sm font-medium text-foreground">
												{item.custom === true ? t(humanise_word(item.name)) : driverLabel(item.driver)}
											</span>
											{#if active}
												<Icon name="lucide:check" class="size-4 shrink-0 text-foreground" />
											{/if}
										</span>
										{#if item.description !== ''}
											<span class="line-clamp-2 text-meta">{item.description}</span>
										{/if}
									</span>
								</button>
							{/each}
						</Grid>
					{:else}
						{@const creating_fields = new_definition.configuration}
						<Inline gap="sm" align="center" justify="between">
							<Inline gap="sm" align="center" class="min-w-0">
								<span class="grid size-8 shrink-0 place-items-center rounded-control border border-border bg-background">
									<Icon name={driverIcon(new_definition.driver)} class="size-4" />
								</span>
								<span class="truncate text-sm font-medium text-foreground">
									{new_definition.custom === true ? t(humanise_word(new_definition.name)) : driverLabel(new_definition.driver)}
								</span>
							</Inline>
							<Button
								variant="ghost"
								onclick={() => {
									creating_definition = null;
									create_error = null;
								}}>{t('Change')}</Button
							>
						</Inline>
						{#key new_definition.name}
							{#await integration_setups?.[new_definition.name]?.load().catch(() => undefined) then companion}
								{#if companion?.configuration_tab === undefined && companion?.create !== undefined}
									<companion.create
										integration={new_definition.name}
										create={create_connection(new_definition.name)}
										busy={create_busy}
										error={create_error}
										{t}
										{locale}
									/>
								{:else}
									<Form
										{ctx}
										of="sys_integration"
										mode="create"
										values={{
											integration: new_definition.name,
											name: new_definition.custom === true ? t(humanise_word(new_definition.name)) : driverLabel(new_definition.driver)
										}}
										submit={t('Create connection')}
										on_outcome={(outcome) => {
											if (outcome.kind !== 'committed') return;
											const record = outcome.records.find((row) => row.model === 'sys_integration');
											if (record === undefined) return;
											creating = false;
											creating_definition = null;
											open = record.id;
											fork(reload());
										}}
									>
										<Field {ctx} name="name" label={t('Name')} />
										{#if Object.keys(creating_fields).length > 0}
											<Field {ctx} name="configuration" label={t('Configuration')}>
												{#snippet editor(field)}
													<ConfigurationFields
														{ctx}
														integration={new_definition.name}
														fields={creating_fields}
														{field}
														{t}
														translate={(key) => bolt.t(key)}
													/>
												{/snippet}
											</Field>
										{/if}
									</Form>
								{/if}
							{/await}
						{/key}
					{/if}
				</Stack>
			</div>
		</Sheet>
	{:else}
		<Envoys
			{ctx}
			{api}
			{bolt}
			{settings}
			{t}
			{locale}
			{configuration}
			on_manage={(instance) => (open = instance)}
			{reload}
		/>
	{/if}
{/if}

{#if current !== undefined}
	{@const i = current}
	{@const d = definition(i.integration)}
	{@const boundEnvoys = boundEnvoysOf(i.id)}
	{@const channel = boundEnvoys.length > 0}
	{@const details_fields = [
		{ label: t('Integration'), value: i.integration === i.name ? undefined : i.integration },
		{ label: t('Driver'), value: channel ? driverLabel(d?.driver ?? '') : undefined },
		{ label: t('Owner'), value: i.owner === null ? undefined : memberName(i.owner) },
		...(d?.conversation === true && d.sends
			? [
					{ label: t('Sent'), value: i.delivery.sent },
					{ label: t('Queued'), value: i.delivery.pending },
					{ label: t('Retrying'), value: i.delivery.retrying },
					{ label: t('Failed'), value: i.delivery.failed },
					{ label: t('Skipped'), value: i.delivery.skipped },
					{
						label: t('Next retry'),
						value: i.delivery.nextRetry === null ? undefined : when(i.delivery.nextRetry)
					},
					{ label: t('Error'), value: i.delivery.lastError ?? undefined }
				]
			: [])
	]}
	{#key i.id}
		<section
			class="flex min-w-0 flex-col gap-4"
			data-integration-management={i.id}
			tabindex="-1"
			aria-label={i.name}
			{@attach (element) => {
				element.scrollIntoView({ block: 'start' });
				element.focus({ preventScroll: true });
			}}
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<Stack gap="xs" align="start">
					<Button
						variant="ghost"
						onclick={() => {
							open = null;
						}}>{t(connections ? 'Back to connections' : 'Back to envoys')}</Button
					>
					<h3 class="text-base font-medium">{i.name}</h3>
				</Stack>
				<Button variant="ghost" onclick={() => remove(i)}>{t('Delete connection')}</Button>
			</div>
			<details class="text-xs text-muted-foreground">
				<summary class="cursor-pointer">{t('Activity and account details')}</summary>
				<dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
					{#each details_fields.filter((field) => field.value !== undefined) as field (field.label)}
						<div>
							<dt>{field.label}</dt>
							<dd class="mt-0.5 text-sm text-foreground break-words">
								{field.value === null ? '—' : String(field.value)}
							</dd>
						</div>
					{/each}
				</dl>
			</details>
			{#if error !== null}
				<p role="alert" class="text-sm text-destructive" data-instance-error>
					{error}
				</p>
			{/if}
			<div class={channel ? 'border-t pt-3' : undefined}>
				{#snippet connectionTab()}
					{@const offer = offers.current?.find((item) => item.integration === i.integration)}
					{#if offers.error !== undefined}
						<p role="alert" class="text-sm text-destructive">{offers.error.message}</p>
					{/if}
					<div class="min-w-0">
						<IntegrationCard
							presentation="inline"
							driver={d?.driver ?? i.integration}
							name={i.name}
							description={d?.description ?? ''}
							providers={i.owner === null ? (offer?.workspace ?? []) : (offer?.personal ?? [])}
							providers_ready={!offers.loading}
							instance={{ id: i.id, status: i.status, active: i.active }}
							client={(id) => api.integration(id)}
							create={() => Effect.succeed(i.id)}
							on_resume={() => resumeInstance(i)}
							setup={integration_setups?.[i.integration]}
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
						/>
					</div>
				{/snippet}
				{#snippet syncTab()}
					<div class="flex flex-col gap-3 text-sm" data-instance-sync>
						<div class="flex items-center justify-between gap-3">
							<h3 class="font-medium">{t('Sync health')}</h3>
							<Button
								variant="ghost"
								disabled={syncHealth.loading}
								onclick={() => fork(syncHealth.refetch())}>{t('Refresh')}</Button
							>
						</div>
						{#if syncHealth.error !== undefined}
							<p role="alert" class="text-destructive">
								{syncHealth.error.message}
							</p>
						{/if}
						{#if syncHealth.current}
							{@const health = syncHealth.current}
							<dl class="grid grid-cols-2 gap-x-4 gap-y-3">
								<div>
									<dt class="text-meta">{t('Last read')}</dt>
									<dd>{when(health.last_read_at)}</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Read lag')}</dt>
									<dd class="tabular-nums">
										{health.lag_seconds === null
											? '—'
											: t('{seconds} s').replace(
													'{seconds}',
													String(Math.max(0, Math.round(health.lag_seconds)))
												)}
									</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Last change')}</dt>
									<dd>{when(health.last_change_at)}</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Last webhook')}</dt>
									<dd>{when(health.last_hint_at)}</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Pending writes')}</dt>
									<dd class="tabular-nums">{health.pending}</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Dead letters')}</dt>
									<dd class="tabular-nums">{health.dead}</dd>
								</div>
								<div>
									<dt class="text-meta">{t('Failed writes')}</dt>
									<dd class="tabular-nums">{health.failed}</dd>
								</div>
							</dl>
							{#if health.webhooks_quiet}
								<p role="status" class="text-warning">
									{t('Webhooks are quiet while reads still find changes.')}
								</p>
							{/if}
							{#if health.dead > 0 || health.initialization !== null}
								<div class="flex flex-col items-start gap-2 border-t pt-3">
									{#if health.initialization !== null}
										<p role="alert" class="text-destructive break-words">
											{t('Initial sync could not finish.')}{#if health.initialization.message !== null}{' '}{health.initialization.message}{/if}
										</p>
									{/if}
									<p class="text-meta">
										{t(
											health.initialization === null
												? 'Retry deliveries that stopped after repeated failures.'
												: 'Retry the initial sync and replay dead-lettered deliveries.'
										)}
									</p>
									<Button variant="outline" disabled={replaying === i.id} onclick={replaySync}
										>{t(
											replaying === i.id
												? 'Replaying…'
												: health.initialization === null
													? 'Replay dead letters'
													: 'Retry sync'
										)}</Button
									>
									{#each dead_letters.current ?? [] as letter (letter.id)}
										<div class="w-full rounded-sm border p-2 text-sm">
											<div class="flex flex-wrap items-center justify-between gap-2">
												<Button
													variant="link"
													onclick={() => open_record(letter.model, letter.record)}
												>
													{letter.model} · {t('Revision')}
													{letter.revision}
												</Button>
												<Button
													variant="outline"
													disabled={retiring !== null}
													onclick={() => retireWrite(letter.id)}
												>
													{t(retiring === letter.id ? 'Retiring…' : 'Retire write')}
												</Button>
											</div>
											<p class="text-meta">{when(letter.at)} · {letter.message ?? t('Not set')}</p>
										</div>
									{/each}
									{#if dead_letters.error !== undefined}
										<p role="alert" class="text-destructive">
											{dead_letters.error.message}
										</p>
									{/if}
								</div>
							{/if}
						{:else if syncHealth.loading}
							<p role="status" aria-busy="true" class="text-meta inline-flex items-center gap-1.5">
								<Spinner class="size-3.5" />{t('Loading…')}
							</p>
						{/if}
					</div>
				{/snippet}
				{#snippet settingsTab()}
					{#snippet configurationEditor(field: FieldEditor)}
						<ConfigurationFields
							{ctx}
							integration={i.integration}
							fields={d?.configuration ?? {}}
							{field}
							{t}
							translate={(key) => bolt.t(key)}
						/>
					{/snippet}
					{#snippet listenEditor(field: FieldEditor)}
						<ListeningScopeEditor
							driver={d?.driver ?? i.integration}
							instance={i.id}
							client={api.integration(i.id)}
							value={listeningScopeOf(field.value)}
							on_change={(next) => field.on_change(next)}
							teams={settings.teams}
							members={memberChoices}
							disabled={field.disabled}
							{t}
						/>
					{/snippet}
					{#snippet classifierEditor(field: FieldEditor)}
						<ClassifierEditor
							value={classifierConfigOf(field.value)}
							on_change={(next) => field.on_change(next)}
							automations={offerOf(i.integration)?.automations ?? []}
							disabled={field.disabled}
							{t}
						/>
					{/snippet}
					<Stack gap="md">
						{#if boundEnvoys.length > 0}
							<p class="text-meta">
								{t('Shared with envoys: {names}').replace(
									'{names}',
									boundEnvoys.map((e) => e.name).join(', ')
								)}
							</p>
						{/if}
						<Form
							{ctx}
							of="sys_integration"
							mode="update"
							id={i.id}
							submit={t('Save')}
							on_outcome={() => fork(reload())}
						>
							<Field {ctx} name="name" label={t('Name')} />
							<Field {ctx} name="active" label={t('Active')} />
							{#if Object.keys(d?.configuration ?? {}).length > 0}
								<Field
									{ctx}
									name="configuration"
									label={t('Configuration')}
									editor={configurationEditor}
								/>
							{/if}
							{#if d?.conversation === true}
								<Field {ctx} name="listen" label={t('Listening scope')} editor={listenEditor} />
								<Field {ctx} name="classifier" label={t('Classifier')} editor={classifierEditor} />
							{/if}
						</Form>
					</Stack>
				{/snippet}
				{#snippet messagesTab()}
					<ConnectionHistory
						{ctx}
						driver={d?.driver ?? i.integration}
						instance={i.id}
						load={(before) => api.instance_messages(i.id, before)}
						locale={bolt.locale}
						{t}
					/>
				{/snippet}
				{#snippet instanceTabs(extra?: { title: string; body: Snippet })}
					<Tabs
						orientation="horizontal"
						bind:value={active_tab}
						tabs={[
							{
								name: 'connection',
								title: t('Connection'),
								icon: 'concept:integrations',
								body: connectionTab,
								keep_alive: true
							},
							{
								name: 'settings',
								title: t('Configuration'),
								icon: 'lucide:settings-2',
								body: settingsTab,
								keep_alive: true
							},
							...(extra === undefined
								? []
								: [{ name: 'definition-settings', icon: 'lucide:sliders-horizontal', ...extra }]),
							...(d?.syncs === true
								? [
										{
											name: 'sync',
											title: t('Sync'),
											icon: 'lucide:refresh-cw',
											body: syncTab,
											keep_alive: true as const
										}
									]
								: []),
							...(d?.conversation === true
								? [
										{
											name: 'messages',
											title: t('Messages'),
											icon: 'lucide:messages-square',
											body: messagesTab,
											keep_alive: true as const
										}
									]
								: [])
						]}
					/>
				{/snippet}
				{#await setup_module}
					<div role="status" aria-busy="true" aria-label={t('Loading…')}>
						<TableSkeleton />
					</div>
				{:then module}
					{#if module?.configuration_tab !== undefined}
						{#snippet extraTab()}<module.default ctx={page_context(bolt, ctx.ui)} />{/snippet}
						{@render instanceTabs({ title: t(module.configuration_tab), body: extraTab })}
					{:else}
						{@render instanceTabs()}
					{/if}
				{:catch}
					{@render instanceTabs()}
				{/await}
			</div>
		</section>
	{/key}
{/if}
